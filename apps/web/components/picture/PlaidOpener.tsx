"use client";
import { useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";

/** Mounts only after a link token exists, opens Plaid Link as soon as it is ready. */
export function PlaidOpener({ token, onPublicToken, onExit }: { token: string; onPublicToken: (t: string) => void; onExit: () => void }) {
  const { open, ready } = usePlaidLink({ token, onSuccess: (publicToken) => (publicToken ? onPublicToken(publicToken) : onExit()), onExit });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}
