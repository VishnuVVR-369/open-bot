"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={mounted ? (theme ?? "") : ""}
      onValueChange={(value) => value && setTheme(value)}
      className="w-fit"
    >
      <ToggleGroupItem value="light" className="px-4">
        <Sun /> Light
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" className="px-4">
        <Moon /> Dark
      </ToggleGroupItem>
      <ToggleGroupItem value="system" className="px-4">
        <Monitor /> System
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
