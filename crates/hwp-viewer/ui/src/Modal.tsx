import { useEffect, type ReactNode } from "react";

/// A minimal accessible modal (replaces the Kobalte Dialog after the React migration): a blurred
/// overlay, Esc-to-close, and click-outside-to-close. Focus management is intentionally light —
/// the palette/composer focus their own primary input on open. Renders nothing when `open` is false.
export function Modal(props: {
  open: boolean;
  onClose: () => void;
  /** Vertical offset class for the centered content (palette sits higher than the composer). */
  topClass?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      }
    };
    // capture so Esc closes the modal before the global app shortcuts (also on window) see it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.open, props.onClose]);

  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={props.onClose} />
      <div className={`absolute inset-x-0 flex justify-center ${props.topClass ?? "top-[14vh]"}`}>
        {/* stop propagation so a click inside the panel doesn't close it */}
        <div onClick={(e) => e.stopPropagation()}>{props.children}</div>
      </div>
    </div>
  );
}
