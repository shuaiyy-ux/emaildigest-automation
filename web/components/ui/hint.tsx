"use client";

import * as React from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";

/** Wrap an interactive element to show a hover-delayed tooltip.
 * children should be a single element (button/Button). */
export function Hint({ label, children, side = "top" }: {
  label: string;
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
