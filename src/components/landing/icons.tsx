import {
  BarChart3, Bell, Check, Cloud, CreditCard, FileText, Fingerprint, Globe, Headset, Heart, KeyRound, Layers3, LockKeyhole,
  Mail, MessageCircle, PenLine, Plug, Puzzle, Rocket, ScanSearch, ShieldCheck, Smartphone, Sparkles, Star, Users, WandSparkles, Zap, Clock,
  type LucideIcon,
} from "lucide-react";
import type { IconName } from "@/modules/landing/schema";

export const ICONS: Record<IconName, LucideIcon> = {
  shield: ShieldCheck, fingerprint: Fingerprint, pen: PenLine, file: FileText, zap: Zap, users: Users, lock: LockKeyhole, clock: Clock,
  smartphone: Smartphone, globe: Globe, chart: BarChart3, bell: Bell, plug: Plug, layers: Layers3, key: KeyRound, check: Check,
  sparkles: Sparkles, wand: WandSparkles, heart: Heart, star: Star, message: MessageCircle, mail: Mail, credit: CreditCard, cloud: Cloud,
  scan: ScanSearch, rocket: Rocket, puzzle: Puzzle, headset: Headset,
};

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const C = ICONS[name as IconName] ?? Check;
  return <C size={size} aria-hidden />;
}
