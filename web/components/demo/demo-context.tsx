"use client";

import { createContext, useContext } from "react";

/** Whether the server runs with DEMO_MODE=1 (read at request time in app/layout.tsx). */
const DemoContext = createContext(false);

export function DemoProvider({ demo, children }: { demo: boolean; children: React.ReactNode }) {
  return <DemoContext.Provider value={demo}>{children}</DemoContext.Provider>;
}

export function useDemo(): boolean {
  return useContext(DemoContext);
}
