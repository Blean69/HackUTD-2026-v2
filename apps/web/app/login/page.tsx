import type { Metadata } from "next";
import { LoginClient } from "./LoginClient";

export const metadata: Metadata = {
  title: "Log in",
  description: "Open a household set up on this device, use the demo account, or try a sample customer.",
};

export default function Page() {
  return <LoginClient />;
}
