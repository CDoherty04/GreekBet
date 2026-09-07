import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

/**
 * Entry point: send signed-in users to their groups, everyone else to
 * onboarding. Reads the session cookie, so this renders per-request.
 */
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? "/groups" : "/onboarding");
}
