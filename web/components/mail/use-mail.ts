import { atom, useAtom } from "jotai";
import { useEffect } from "react";
import type { DynamicCategory } from "@/lib/types";

type View = "inbox" | "jobs" | "drafts" | "sent" | "ask";

const selectedAtom = atom<string | null>(null);
const viewAtom = atom<View>("inbox");
const categoriesAtom = atom<DynamicCategory[]>([]);
const categoriesLoadedAtom = atom<boolean>(false);

export function useMail() {
  const [selected, setSelected] = useAtom(selectedAtom);
  const [view, setView] = useAtom(viewAtom);
  return { selected, setSelected, view, setView };
}

/** Fetch + cache the categories list globally. Call once from the root component. */
export function useCategories() {
  const [categories, setCategories] = useAtom(categoriesAtom);
  const [loaded, setLoaded] = useAtom(categoriesLoadedAtom);

  const refresh = async () => {
    const res = await fetch("/api/categories");
    const data = await res.json();
    setCategories(data.categories || []);
    setLoaded(true);
  };

  useEffect(() => {
    if (!loaded) refresh().catch((e) => console.error("[useCategories] fetch error:", e));
  }, [loaded]);

  return { categories, loaded, refresh };
}
