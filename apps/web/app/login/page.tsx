import type { Metadata } from "next";
import { LoginClient } from "./LoginClient";

export const metadata: Metadata = {
  title: "Log in",
  description: "Open a household set up on this device, or use the demo account.",
};

export default function Page() {
  return <LoginClient />;
}
