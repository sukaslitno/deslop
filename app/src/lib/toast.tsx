import { useEffect, useState } from "react";

import { Toast } from "@/design-system";

type ToastMessage = { id: number; variant: "success" | "danger"; text: string };

let publish: ((message: ToastMessage) => void) | null = null;
let nextId = 0;

/** Fire a toast from anywhere; a no-op until `ToastHost` is mounted. */
export function toast(text: string, variant: ToastMessage["variant"] = "success") {
  publish?.({ id: (nextId += 1), variant, text });
}

// ponytail: one visible toast at a time, newest wins. Add a queue only if two
// results can land within the dismiss window in practice.
export function ToastHost({ timeout = 4000 }: { timeout?: number }) {
  const [message, setMessage] = useState<ToastMessage | null>(null);

  useEffect(() => {
    publish = setMessage;
    return () => {
      publish = null;
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), timeout);
    return () => window.clearTimeout(timer);
  }, [message, timeout]);

  if (!message) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[var(--vc-gap-24)] z-50 flex justify-center px-[var(--vc-gap-24)]">
      <Toast key={message.id} variant={message.variant}>
        {message.text}
      </Toast>
    </div>
  );
}
