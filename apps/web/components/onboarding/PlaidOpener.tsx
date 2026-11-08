"use client";
import { useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";

/**
 * Opens Plaid Link as soon as it is ready. Loaded with next/dynamic only after "Connect with Plaid" is tapped, so the
 * Plaid SDK never ships in the wizard's first load.
 */
export default function PlaidOpener({ token, onSuccess, onExit }: { token: string; onSuccess: (publicToken: string) => void; onExit: () => void }) {
  const { open, ready } = usePlaidLink({ token, onSuccess: (publicToken) => (publicToken ? onSuccess(publicToken) : onExit()), onExit });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}
