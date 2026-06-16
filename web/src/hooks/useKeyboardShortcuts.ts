import { useEffect } from "react";

export interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  callback: () => void;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[] = []): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        const matchKey = event.key.toLowerCase() === shortcut.key.toLowerCase();
        const matchCtrl = shortcut.ctrlKey ? event.ctrlKey : !event.ctrlKey;
        const matchShift = shortcut.shiftKey ? event.shiftKey : !event.shiftKey;
        const matchAlt = shortcut.altKey ? event.altKey : !event.altKey;

        if (matchKey && matchCtrl && matchShift && matchAlt) {
          event.preventDefault();
          shortcut.callback();
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}
