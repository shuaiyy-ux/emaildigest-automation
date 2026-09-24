import {
  GraduationCap, FileText, Briefcase, Building2, Megaphone,
  Newspaper, Users, Bell, Ban, Tag, ShoppingBag, Plane, Wallet,
  HelpCircle, Heart, Star, Mail, Inbox, Bookmark,
  ListChecks, CheckSquare, Trash2, Archive, Clock,
} from "lucide-react";

export const ICON_MAP: Record<string, typeof GraduationCap> = {
  GraduationCap, FileText, Briefcase, Building2, Megaphone, Newspaper, Users, Bell, Ban,
  Tag, ShoppingBag, Plane, Wallet, HelpCircle, Heart, Star, Mail, Inbox, Bookmark,
  ListChecks, CheckSquare, Trash2, Archive, Clock,
};

export const ICON_NAMES = Object.keys(ICON_MAP);

export function getCategoryIcon(name: string) {
  return ICON_MAP[name] || Tag;
}
