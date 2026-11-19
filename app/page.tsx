import { redirect } from 'next/navigation'

/** The admin host has no landing page: `/` is the console. The proxy redirects first. */
export default function RootPage() {
  redirect('/admin')
}
