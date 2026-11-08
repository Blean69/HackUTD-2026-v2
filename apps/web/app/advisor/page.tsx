import { redirect } from "next/navigation";

/** The Advisor Console is gone (docs/contracts.md section 11): the product is entirely end-user facing. Old links land home. */
export default function AdvisorPage() {
  redirect("/");
}
