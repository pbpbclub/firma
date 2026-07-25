// Быстрый переход в мессенджер из любой карточки с контактами.
// Один источник правды по ссылкам: карточки вики, клиент в карточке заказа.
import { useState } from "react";
import { Phone, EnvelopeSimple, TelegramLogo, WhatsappLogo, InstagramLogo } from "@phosphor-icons/react";

export type ContactKind = "phone" | "email" | "telegram" | "whatsapp" | "instagram";

const digits = (v: string) => v.replace(/[^\d+]/g, "");
// @user / t.me/user / https://t.me/user → user
const handle = (v: string) =>
  v.trim().replace(/^@/, "").replace(/^https?:\/\//, "").replace(/^(t\.me|telegram\.me|instagram\.com|www\.instagram\.com)\//, "");

export function contactHref(kind: ContactKind, value?: string | null): string | undefined {
  const v = (value || "").trim();
  if (!v) return undefined;
  switch (kind) {
    case "phone":     return `tel:${digits(v)}`;
    case "email":     return `mailto:${v}`;
    case "telegram":  return `https://t.me/${handle(v)}`;
    case "whatsapp":  return `https://wa.me/${digits(v).replace(/^\+/, "")}`;
    case "instagram": return `https://instagram.com/${handle(v)}`;
  }
}

const META: Record<ContactKind, { Icon: any; label: string }> = {
  telegram:  { Icon: TelegramLogo,  label: "Telegram" },
  whatsapp:  { Icon: WhatsappLogo,  label: "WhatsApp" },
  instagram: { Icon: InstagramLogo, label: "Instagram" },
  phone:     { Icon: Phone,         label: "Позвонить" },
  email:     { Icon: EnvelopeSimple, label: "Написать на почту" },
};

function ContactIcon({ kind, value }: { kind: ContactKind; value: string }) {
  const [hover, setHover] = useState(false);
  const { Icon, label } = META[kind];
  const href = contactHref(kind, value);
  if (!href) return null;
  const external = kind !== "phone" && kind !== "email";
  return (
    <a href={href} title={`${label}: ${value}`}
      target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center",
        border: `1px solid ${hover ? "#E8592A" : "#EDEBE6"}`,
        background: hover ? "#FFF4EE" : "#fff",
        color: hover ? "#E8592A" : "#6B6355", textDecoration: "none", flexShrink: 0,
      }}>
      <Icon size={14} />
    </a>
  );
}

// Ряд иконок по заполненным каналам. WhatsApp — по своему полю, иначе по телефону
// (номер тот же, отдельное поле заполняют не всегда).
export function ContactStrip({ entity, style }: { entity: any; style?: React.CSSProperties }) {
  if (!entity) return null;
  const wa = entity.whatsapp || entity.phone;
  const items: Array<[ContactKind, string]> = [
    ["telegram", entity.telegram],
    ["whatsapp", wa],
    ["instagram", entity.instagram],
    ["phone", entity.phone],
    ["email", entity.email],
  ].filter(([, v]) => !!(v || "").trim()) as Array<[ContactKind, string]>;
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", gap: 6, padding: "2px 0 10px", ...style }}>
      {items.map(([kind, value]) => <ContactIcon key={kind} kind={kind} value={value} />)}
    </div>
  );
}
