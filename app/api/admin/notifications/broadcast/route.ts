import { adminErrorMessage } from '@/lib/errors/api-response'
import { NextResponse, after } from 'next/server'
import { logAdminAction } from '@/lib/admin/guard'
import { requireAdmin } from '@/lib/api/actor'
import { withRoute } from '@/lib/api/with-route'
import { createServiceRoleClient } from '@/lib/supabase'
import { enqueueNotificationItem, processEmailQueue } from '@/lib/notifications/queue/processor'
import { createInAppNotification } from '@/lib/notifications/in-app/service'
import { logSystemError } from '@/lib/monitoring/logger'
import { revalidatePath } from 'next/cache'
import { evaluatePersistentRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * This route sends one by one inside a single request. Above this many recipients it
 * would run out of function time partway through, so larger audiences belong in the
 * batched, resumable email broadcasts (BroadcastService).
 */
const MAX_DIRECT_BROADCAST_RECIPIENTS = 500

interface BroadcastRecipient {
  id: string
  email: string
  name: string
}

export const POST = withRoute(
  {
    actor: { allow: ['admin'] },
    operation: 'admin.notifications.broadcast.post',
    domain: 'admin',
    summary: 'Unexpected failure in POST /api/admin/notifications/broadcast',
  },
  async ({ request, actor }) => {
    try {
      const admin = requireAdmin(actor)
      const body = await request.json()
      const {
        audience = 'individual',
        targetUserId,
        cohortId,
        channel = 'both',
        subject,
        content,
        templateKey = 'system.announcement',
        actionUrl,
        scheduledAt,
        idempotencyKey,
      } = body

      if (!subject || typeof subject !== 'string' || !subject.trim()) {
        return NextResponse.json({ error: 'Notification subject is required.' }, { status: 400 })
      }

      if (!content || typeof content !== 'string' || !content.trim()) {
        return NextResponse.json({ error: 'Notification content is required.' }, { status: 400 })
      }

      if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 200) {
        return NextResponse.json({ error: 'idempotencyKey is required to prevent duplicate broadcasts.' }, { status: 400 })
      }

      const supabase = createServiceRoleClient()

      // 1. Idempotency Check: check if broadcast with this idempotency key was recorded
      const { data: existingAudit } = await supabase
        .from('admin_audit_logs')
        .select('id, created_at')
        .eq('action', 'notification_broadcast_sent')
        .eq('target_id', idempotencyKey)
        .maybeSingle()

      if (existingAudit) {
        return NextResponse.json({
          error: 'This broadcast has already been submitted and processed (idempotency key matched).',
        }, { status: 409 })
      }

      // 2. Resolve Target Audience
      const recipients: BroadcastRecipient[] = []

      if (audience === 'individual') {
        if (!targetUserId) {
          return NextResponse.json({ error: 'targetUserId is required for individual audience.' }, { status: 400 })
        }
        const { data: u } = await supabase
          .from('users')
          .select('id, email, name')
          .eq('id', targetUserId)
          .maybeSingle()

        if (!u) {
          return NextResponse.json({ error: 'Target user not found.' }, { status: 404 })
        }
        recipients.push({
          id: u.id,
          email: u.email,
          name: u.name || 'Learner',
        })
      } else if (audience === 'cohort') {
        if (!cohortId) {
          return NextResponse.json({ error: 'cohortId is required for cohort audience.' }, { status: 400 })
        }
        const { data: members } = await supabase
          .from('cohort_members')
          .select('user_id, users(id, email, name)')
          .eq('cohort_id', cohortId)

        if (members) {
          for (const m of members) {
            const u = m.users as unknown as { id: string; email: string; name: string | null } | null
            if (u?.email) {
              recipients.push({ id: u.id, email: u.email, name: u.name || 'Learner' })
            }
          }
        }
      } else if (audience === 'all') {
        // Fetch active registered learners (cap at safe broadcast bound: 10,000)
        const { data: allUsers } = await supabase
          .from('users')
          .select('id, email, name')
          .order('created_at', { ascending: false })
          .limit(10000)

        if (allUsers) {
          for (const u of allUsers) {
            if (u.email) {
              recipients.push({ id: u.id, email: u.email, name: u.name || 'Learner' })
            }
          }
        }
      } else {
        return NextResponse.json({ error: `Unsupported audience '${audience}'` }, { status: 400 })
      }

      if (recipients.length === 0) {
        return NextResponse.json({ error: 'No eligible recipients found for this audience.' }, { status: 400 })
      }

      if (recipients.length > MAX_DIRECT_BROADCAST_RECIPIENTS) {
        return NextResponse.json(
          {
            error: `This audience has ${recipients.length} recipients. Quick broadcasts are limited to ${MAX_DIRECT_BROADCAST_RECIPIENTS}; use Email broadcasts in Communications for larger audiences.`,
          },
          { status: 400 }
        )
      }

      // Claim the key atomically before sending anything. The completed-audit check above
      // only sees broadcasts that finished, so a double click or a retry after a timeout
      // used to start a second full send. Fails closed: no claim, no send.
      const claim = await evaluatePersistentRateLimit(`admin_broadcast:${idempotencyKey}`, {
        limit: 1,
        windowMs: 7 * 24 * 60 * 60 * 1000,
        failClosed: true,
      })
      if (!claim.success) {
        return NextResponse.json(
          { error: 'This broadcast is already being sent or was sent (idempotency key matched).' },
          { status: 409 }
        )
      }

      // Recorded before the loop so a send that dies partway still leaves a trail.
      await logAdminAction(
        admin.userId,
        admin.email || 'admin@prodily.me',
        'notification_broadcast_started',
        'notification',
        idempotencyKey,
        { audience, channel, subject: subject.trim(), totalRecipients: recipients.length }
      )

      let enqueuedCount = 0
      let inAppCount = 0
      const errors: string[] = []

      // 3. Dispatch to In-App and/or Email channels
      const sendInApp = channel === 'in_app' || channel === 'both'
      const sendEmail = channel === 'email' || channel === 'both'

      for (const recipient of recipients) {
        // The full key: the modal's keys all start `bcast-<timestamp>`, so the first 8
        // characters were the same for every broadcast and in-app dedupe could drop
        // a later broadcast as a duplicate of an earlier one.
        const eventId = `bcast-${idempotencyKey}-${recipient.id}`

        if (sendInApp) {
          try {
            await createInAppNotification({
              userId: recipient.id,
              eventId,
              category: 'announcement',
              title: subject.trim(),
              body: content.trim(),
              actionUrl: actionUrl || undefined,
              priority: 'high',
            })
            inAppCount++
          } catch (inAppErr) {
            errors.push(`In-App error for ${recipient.email}: ${adminErrorMessage(inAppErr, 'Unknown')}`)
          }
        }

        if (sendEmail) {
          try {
            const res = await enqueueNotificationItem({
              userId: recipient.id,
              toEmail: recipient.email,
              toName: recipient.name,
              channel: 'email',
              templateKey: templateKey || 'system.announcement',
              templateVariables: {
                userName: recipient.name,
                subject: subject.trim(),
                announcementTitle: subject.trim(),
                announcementBody: content.trim(),
                actionUrl: actionUrl || undefined,
              },
              eventType: 'admin.broadcast',
              // An announcement is a product update, so a learner who opted out of
              // product updates is skipped by the queue's preference check.
              category: 'product_updates',
              // Not 'high': high priority starts an inline queue run per recipient.
              priorityLevel: 'low',
              // One row per recipient per broadcast, enforced by the unique index on
              // email_queue.idempotency_key, so a retry never queues a second copy.
              idempotencyKey: `admin-broadcast:${idempotencyKey}:${recipient.id}`,
            })
            if (res.success) {
              enqueuedCount++
            }
          } catch (emailErr) {
            errors.push(`Email error for ${recipient.email}: ${adminErrorMessage(emailErr, 'Unknown')}`)
          }
        }
      }

      // 4. Trigger queue worker if sending email immediately
      // after() keeps the function alive until the run finishes; a bare `void` call
      // could be frozen once the response was sent, leaving claimed rows stuck.
      if (sendEmail && enqueuedCount > 0 && process.env.NODE_ENV !== 'test') {
        after(() => processEmailQueue(Math.min(50, enqueuedCount)).then(() => undefined, () => undefined))
      }

      // 5. Log Administrative Action
      await logAdminAction(
        admin.userId,
        admin.email || 'admin@prodily.me',
        'notification_broadcast_sent',
        'notification',
        idempotencyKey,
        {
          audience,
          channel,
          subject: subject.trim(),
          totalRecipients: recipients.length,
          inAppCreated: inAppCount,
          emailEnqueued: enqueuedCount,
          scheduledAt: scheduledAt || null,
          errorCount: errors.length,
        }
      )

      revalidatePath('/admin/communications')

      return NextResponse.json({
        success: true,
        message: `Broadcast successfully dispatched to ${recipients.length} recipients.`,
        stats: {
          totalRecipients: recipients.length,
          inAppCreated: inAppCount,
          emailEnqueued: enqueuedCount,
          errors: errors.slice(0, 5),
        },
      })
    } catch (err) {
      const errorMsg = adminErrorMessage(err, 'Unknown server error during broadcast')
      void logSystemError({
        severity: 'error',
        category: 'system',
        operation: 'admin_notification_broadcast_exception',
        message: errorMsg,
      })
      return NextResponse.json({ error: errorMsg }, { status: 500 })
    }
  }
)
