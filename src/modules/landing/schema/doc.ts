import { type LandingDoc, type Props, type Section, type SectionType } from "./model";
import { GLOBAL_DEFS, SECTION_DEFS } from "./defs";
import { SECTION_STARTERS, defaultDoc } from "./defaults";
import { ID_RE, MAX_SECTIONS, newId, sanitizeProps } from "./sanitize";

function withColorFallback(theme: Props): Props {
  const base = defaultDoc().theme;
  return { ...theme, primary: theme.primary || base.primary, accent: theme.accent || base.accent };
}
export function sanitizeDoc(input: unknown): LandingDoc {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawSections = Array.isArray(src.sections) ? src.sections.slice(0, MAX_SECTIONS) : [];
  const seen = new Set<string>();
  const sections: Section[] = [];
  for (const r of rawSections) {
    if (!r || typeof r !== "object") continue;
    const s = r as Record<string, unknown>;
    const type = s.type as SectionType;
    const def = SECTION_DEFS[type];
    if (!def) continue;
    let id = typeof s.id === "string" && ID_RE.test(s.id) ? s.id : newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    sections.push({ id, type, enabled: s.enabled !== false, props: sanitizeProps(def.fields, s.props) });
  }
  return {
    v: 1,
    theme: withColorFallback(sanitizeProps(GLOBAL_DEFS.theme, src.theme)),
    seo: sanitizeProps(GLOBAL_DEFS.seo, src.seo),
    announcement: sanitizeProps(GLOBAL_DEFS.announcement, src.announcement),
    nav: sanitizeProps(GLOBAL_DEFS.nav, src.nav),
    footer: sanitizeProps(GLOBAL_DEFS.footer, src.footer),
    sections,
  };
}
/** بخش تازه با مقدار پیش‌فرض مناسب (نمونه‌متن‌های راهنما) */
export function newSection(type: SectionType): Section {
  const base = sanitizeProps(SECTION_DEFS[type].fields, {});
  return { id: newId(), type, enabled: true, props: { ...base, ...SECTION_STARTERS[type] } };
}
