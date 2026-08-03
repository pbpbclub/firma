#!/usr/bin/env python3
"""Генерация счёта на оплату с QR-кодом — ИП Некрасов Юрий Владимирович."""

import argparse
import base64
import fcntl
import io
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from num2words import num2words
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from money import client_price   # единая формула безнала (см. firma/backend/money.py)

try:
    import qrcode
    from PIL import Image
except ImportError:
    print("Установите: pip3 install qrcode[pil] pillow num2words --break-system-packages", file=sys.stderr)
    sys.exit(1)

_RU_MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня",
              "июля", "августа", "сентября", "октября", "ноября", "декабря")


def ru_date(d=None) -> str:
    """«3 августа 2026» — strftime('%B') зависит от локали и даёт латиницу."""
    d = d or datetime.now()
    return f"{d.day} {_RU_MONTHS[d.month - 1]} {d.year}"


ASSET_DIR    = Path(__file__).parent.parent / "data" / "assets"
UPLOAD_DIR   = Path(__file__).parent.parent / "data" / "uploads"
OUTPUT_DIR   = Path(__file__).parent.parent / "data" / "invoices"
# Счётчик номеров — ОБЩИЙ с фин-агентом (03.08.2026): у трёх копий генератора
# были свои счётчики, и номера 7001–7004 успели выдаться дважды. Один файл —
# один ряд номеров; сервис firma работает от root, права есть.
COUNTER_FILE = Path("/opt/fin-agent/data/invoice_counter.json")
# Ассеты: свой каталог пуст — фолбэк на файлы фин-агента (root прочитает),
# иначе счёт уходил без подписи и логотипа.
_FIN_UPLOADS = Path("/opt/fin-agent/data/uploads")
def _first_existing(*paths):
    for pth in paths:
        if pth.exists():
            return pth
    return paths[0]
SIGNATURE_FILE = _first_existing(UPLOAD_DIR / "Artboard1.png", _FIN_UPLOADS / "Artboard1.png")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
ASSET_DIR.mkdir(parents=True, exist_ok=True)


def next_invoice_num() -> str:
    """Следующий номер счёта (с 7001) — атомарно: блокировка + запись через rename.

    Файл общий с фин-агентом, пишут в него два независимых процесса. Голый
    read-modify-write (как было до 04.08.2026) при одновременном запуске выдаёт
    обоим один номер — ровно та беда, ради которой счётчики и объединяли:
    объединение без блокировки лишь переносит гонку в одно место.
    Лок держится на отдельном .lock (не на самом файле): счётчик мы подменяем
    через rename, и дескриптор жертвы разошёлся бы с новым inode."""
    lock_path = COUNTER_FILE.with_suffix(COUNTER_FILE.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            num = 7001
            if COUNTER_FILE.exists():
                try:
                    num = json.loads(COUNTER_FILE.read_text()).get("last", 7000) + 1
                except (json.JSONDecodeError, ValueError):
                    # Битый счётчик молча обнулять нельзя: номера пойдут по второму кругу.
                    raise SystemExit(f"Счётчик номеров повреждён: {COUNTER_FILE}")
            tmp = COUNTER_FILE.with_suffix(COUNTER_FILE.suffix + ".tmp")
            tmp.write_text(json.dumps({"last": num}))
            os.replace(tmp, COUNTER_FILE)   # атомарная подмена, без окна «пустой файл»
            return str(num)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

# ── реквизиты ────────────────────────────────────────────────────────────────

SUPPLIER = {
    "name":     "ИП НЕКРАСОВ ЮРИЙ ВЛАДИМИРОВИЧ",
    "inn":      "366409706709",
    "ogrnip":   "320366800068510",
    "address":  "394018, РОССИЯ, ВОРОНЕЖСКАЯ ОБЛ, Г ВОРОНЕЖ, УЛ ПУШКИНСКАЯ, Д 18, КВ 37",
    "phone":    "+7 920 405-14-88",
}

BANKS = {
    "tbank": {
        "label":       "АО «ТБанк»",
        "bik":         "044525974",
        "corr":        "30101810145250000974",
        "account":     "40802810400004306154",
    },
    "sber": {
        "label":       "ПАО Сбербанк",
        "bik":         "042007681",
        "corr":        "30101810600000000681",
        "account":     "40802810113000047460",
    },
}

LOGOS = {
    "mera": _first_existing(UPLOAD_DIR / "New new_small.png", _FIN_UPLOADS / "New new_small.png"),
    "pbpb": _first_existing(ASSET_DIR / "pbpb_logo.png",
                            Path("/opt/ai-os/data/assets/pbpb_logo.png"),
                            Path("/opt/fin-agent/data/assets/pbpb_logo.png")),
}


# ── QR-код оплаты (ST00012) ──────────────────────────────────────────────────

def make_payment_qr(bank_key: str, amount: float, purpose: str, invoice_num: str) -> str:
    """Возвращает QR как base64 PNG."""
    b = BANKS[bank_key]
    amount_kopecks = int(round(amount * 100))
    payload = (
        f"ST00012"
        f"|Name={SUPPLIER['name']}"
        f"|PersonalAcc={b['account']}"
        f"|BankName={b['label']}"
        f"|BIC={b['bik']}"
        f"|CorrespAcc={b['corr']}"
        f"|Sum={amount_kopecks}"
        f"|Purpose={purpose} Счет №{invoice_num}"
        f"|PayeeINN={SUPPLIER['inn']}"
    )
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=6, border=2)
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


# ── сумма прописью ───────────────────────────────────────────────────────────

def amount_words(amount: float) -> str:
    rubles = int(amount)
    kopecks = round((amount - rubles) * 100)
    w = num2words(rubles, lang="ru")
    # первая буква заглавная
    w = w[0].upper() + w[1:]
    return f"{w} рублей {kopecks:02d} копеек"


# ── логотип → base64 ─────────────────────────────────────────────────────────

def logo_b64(logo_key: str) -> str:
    path = LOGOS.get(logo_key)
    if path and Path(path).exists():
        return base64.b64encode(Path(path).read_bytes()).decode()
    return ""


def get_sig_b64() -> str:
    if SIGNATURE_FILE.exists():
        return base64.b64encode(SIGNATURE_FILE.read_bytes()).decode()
    return ""


def buyer_slug(buyer_name: str) -> str:
    """Превращает название организации в безопасную строку для имени файла."""
    import re
    name = buyer_name.upper()
    for stop in ["ООО", "ИП", "АО", "ПАО", "ЗАО", "НКО", "МУП", "МБУ", "ГУП"]:
        name = name.replace(stop, "")
    name = re.sub(r'[«»"\'<>|/\\:*?\s]+', "_", name)
    name = re.sub(r'_+', "_", name).strip("_")
    return name[:40] or "org"


# ── HTML-шаблон ──────────────────────────────────────────────────────────────

HTML_TMPL = """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: Arial, sans-serif; font-size: 9pt; color: #000; padding: 14mm 14mm 10mm; }}

  /* верхняя полоса: логотип + QR */
  .top-bar {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }}
  .top-bar .logo img {{ max-height: 120px; max-width: 380px; }}
  .top-bar .qr-top img {{ width: 170px; height: 170px; display: block; }}
  .top-bar .qr-top {{ text-align: center; font-size: 7pt; color: #555; }}

  /* банковская шапка — таблица */
  table.bank-tbl {{ width: 100%; border-collapse: collapse; border: 1px solid #000; margin-bottom: 0; font-size: 8.5pt; }}
  table.bank-tbl td {{ border: 1px solid #000; padding: 3px 6px; vertical-align: middle; }}
  table.bank-tbl .lbl {{ color: #555; font-size: 7.5pt; display: block; }}
  table.bank-tbl .bold {{ font-weight: bold; }}
  table.bank-tbl .w-label {{ width: 36px; white-space: nowrap; color: #555; font-size: 7.5pt; }}

  /* заголовок счёта */
  .invoice-title {{ font-size: 16pt; font-weight: bold; margin: 10px 0 6px; }}
  hr.sep {{ border: none; border-top: 1px solid #000; margin: 4px 0 6px; }}

  /* стороны */
  .parties {{ font-size: 8.5pt; line-height: 1.5; margin-bottom: 10px; }}
  .parties .lbl {{ font-weight: normal; }}
  .parties .val {{ font-weight: bold; }}

  /* таблица позиций */
  table.items {{ width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 8.5pt; }}
  table.items th, table.items td {{ border: 1px solid #000; padding: 3px 5px; }}
  table.items th {{ background: #fff; text-align: center; font-weight: bold; }}
  table.items td.num  {{ text-align: center; width: 22px; }}
  table.items td.qty  {{ text-align: center; width: 42px; }}
  table.items td.unit {{ text-align: center; width: 28px; }}
  table.items td.vat  {{ text-align: center; width: 60px; white-space: nowrap; }}
  table.items td.price, table.items td.sum {{ text-align: right; width: 80px; white-space: nowrap; }}

  /* итого */
  .totals-row {{ display: flex; justify-content: space-between; align-items: baseline;
                 font-size: 9pt; margin: 4px 0 0; }}
  .totals-right {{ font-weight: bold; font-size: 11pt; }}
  .amount-words {{ font-weight: bold; font-size: 9pt; margin: 4px 0 6px; }}
  hr.sep-bottom {{ border: none; border-top: 1px solid #000; margin: 6px 0 12px; }}
  .sig-block {{ margin-top: 42px; }}

  /* подписи */
  .sig-block {{ margin-top: 30px; }}
  .sig-row {{ display: flex; align-items: flex-end; gap: 14px; font-size: 9pt; font-weight: bold; }}
  .sig-label {{ white-space: nowrap; }}
  .sig-line-wrap {{ flex: 1; max-width: 540px; display: flex; flex-direction: column; align-items: center; }}
  .sig-img {{ max-height: 126px; max-width: 540px; display: block; }}
  .sig-underline {{ width: 100%; border-top: 1px solid #000; margin-top: 4px; }}
  .sig-name {{ white-space: nowrap; }}
</style>
</head>
<body>

<!-- логотип + QR вверху -->
<div class="top-bar">
  <div class="logo">{logo_block}</div>
  <div class="qr-top">
    <img src="data:image/png;base64,{qr_b64}" alt="QR оплата">
    Оплата по QR
  </div>
</div>

<!-- банковская шапка -->
<table class="bank-tbl">
  <tr>
    <td style="width:55%">
      <span class="bold">{bank_label}</span><br>
      <span class="lbl">Банк получателя</span>
    </td>
    <td class="w-label">БИК<br>Сч. №</td>
    <td>
      <span class="bold">{bank_bik}</span><br>
      {bank_corr}
    </td>
  </tr>
  <tr>
    <td>
      ИНН {inn}<br>
      <span class="bold">{supplier_name}</span><br>
      <span class="lbl">Получатель</span>
    </td>
    <td class="w-label">Сч. №</td>
    <td><span class="bold">{bank_account}</span></td>
  </tr>
</table>

<!-- заголовок -->
<div class="invoice-title">Счет на оплату № {invoice_num} от {invoice_date} г.</div>
<hr class="sep">

<!-- стороны -->
<div class="parties">
  <span class="lbl">Поставщик:</span>&nbsp;<span class="val">{supplier_name}, ИНН {inn}, {supplier_address}</span><br><br>
  <span class="lbl">Покупатель:</span>&nbsp;<span class="val">{buyer_name}{buyer_inn_kpp}{buyer_address}</span>
</div>

<!-- позиции -->
<table class="items">
  <thead>
    <tr>
      <th class="num">№</th>
      <th>Товары (работы, услуги)</th>
      <th class="qty">кол-во</th>
      <th class="unit">Ед.</th>
      <th class="vat">НДС</th>
      <th class="price">Цена</th>
      <th class="sum">Сумма</th>
    </tr>
  </thead>
  <tbody>
    {items_rows}
  </tbody>
</table>

<!-- итого -->
<div class="totals-row">
  <span>Всего наименований {item_count}, на сумму {total_fmt} руб.</span>
  <span class="totals-right">Итого к оплате:&nbsp;&nbsp;{total_fmt}</span>
</div>
<div class="amount-words">{amount_words}</div>
<hr class="sep-bottom">

<!-- подписи -->
<div class="sig-block">
  <div class="sig-row">
    <span class="sig-label">Руководитель</span>
    <div class="sig-line-wrap">
      {sig_img_block}
      <div class="sig-underline"></div>
    </div>
    <span class="sig-name">Некрасов Ю.В.</span>
  </div>
</div>

</body>
</html>"""


def fmt_money(v: float) -> str:
    return f"{v:,.2f}".replace(",", " ").replace(".", ",")


def build_html(data: dict) -> str:
    bank_key  = data.get("bank", "tbank")
    logo_key  = data.get("logo", "pbpb")
    bank      = BANKS[bank_key]

    invoice_num  = str(data.get("invoice_num") or next_invoice_num())
    invoice_date = data.get("invoice_date", datetime.now().strftime("%-d %B %Y г."))

    items = data.get("items", [])
    total = sum(i.get("qty", 1) * i.get("price", 0) for i in items)

    items_rows = ""
    for i, item in enumerate(items, 1):
        qty   = item.get("qty", 1)
        price = item.get("price", 0)
        s     = qty * price
        vat   = item.get("vat", "Без НДС")
        unit  = item.get("unit", "шт")
        items_rows += (
            f'<tr>'
            f'<td class="num">{i}</td>'
            f'<td>{item["name"]}</td>'
            f'<td class="qty">{qty}</td>'
            f'<td class="unit">{unit}</td>'
            f'<td class="vat">{vat}</td>'
            f'<td class="price">{fmt_money(price)}</td>'
            f'<td class="sum">{fmt_money(s)}</td>'
            f'</tr>'
        )

    purpose = data.get("purpose", items[0]["name"] if items else "Оплата по счету")
    qr_b64  = make_payment_qr(bank_key, total, purpose, invoice_num)

    buyer     = data.get("buyer", {})
    buyer_inn = buyer.get("inn", "")
    buyer_kpp = buyer.get("kpp", "")
    inn_kpp   = ""
    if buyer_inn:
        inn_kpp = f", ИНН {buyer_inn}"
        if buyer_kpp:
            inn_kpp += f", КПП {buyer_kpp}"
    buyer_addr = buyer.get("address", "")
    if buyer_addr:
        buyer_addr = f", {buyer_addr}"

    logo_b = logo_b64(logo_key)
    logo_block = f'<img src="data:image/png;base64,{logo_b}" alt="logo">' if logo_b else ""

    sig_b = get_sig_b64()
    sig_img_block = f'<img src="data:image/png;base64,{sig_b}" class="sig-img" alt="">' if sig_b else ""

    return HTML_TMPL.format(
        logo_block      = logo_block,
        bank_label      = bank["label"],
        bank_bik        = bank["bik"],
        bank_corr       = bank["corr"],
        bank_account    = bank["account"],
        inn             = SUPPLIER["inn"],
        supplier_name   = SUPPLIER["name"],
        supplier_address= SUPPLIER["address"],
        buyer_name      = buyer.get("name", ""),
        buyer_inn_kpp   = inn_kpp,
        buyer_address   = buyer_addr,
        invoice_num     = invoice_num,
        invoice_date    = invoice_date,
        items_rows      = items_rows,
        item_count      = len(items),
        total_fmt       = fmt_money(total),
        amount_words    = amount_words(total),
        qr_b64          = qr_b64,
        sig_img_block   = sig_img_block,
    )


def html_to_pdf(html: str, output_path: Path) -> Path:
    with tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w", encoding="utf-8") as f:
        f.write(html)
        tmp_html = f.name
    result = subprocess.run(
        ["wkhtmltopdf", "--quiet", "--page-size", "A4",
         "--margin-top", "0", "--margin-bottom", "0",
         "--margin-left", "0", "--margin-right", "0",
         "--encoding", "utf-8",
         tmp_html, str(output_path)],
        capture_output=True, text=True,
    )
    try: Path(tmp_html).unlink()
    except Exception: pass
    if result.returncode != 0:
        raise RuntimeError(f"wkhtmltopdf error: {result.stderr}")
    return output_path


# ── команды ─────────────────────────────────────────────────────────────────

def cmd_generate(args):
    data  = json.loads(Path(args.data).read_text(encoding="utf-8"))
    if not data.get("invoice_num"):
        data["invoice_num"] = next_invoice_num()
    num   = data["invoice_num"]
    slug  = buyer_slug(data.get("buyer", {}).get("name", ""))
    out   = OUTPUT_DIR / f"invoice_{num}_{slug}.pdf"
    html  = build_html(data)
    html_to_pdf(html, out)
    print(f"[SEND_FILE:{out}]")
    print(f"Счет сохранён: {out}")


def cmd_order(args):
    """Сгенерировать счёт по заказу из MES."""
    import sqlite3
    mes = sqlite3.connect("/opt/ai-os/data/production.db")
    mes.row_factory = sqlite3.Row

    order = mes.execute("""
        SELECT o.*, c.name as client_name, c.inn as client_inn,
               c.full_name as client_full, c.notes as client_notes
        FROM orders o
        LEFT JOIN customers c ON o.customer_id = c.id
        WHERE o.number = ?
    """, (args.order,)).fetchone()

    if not order:
        print(f"Заказ {args.order} не найден.", file=sys.stderr)
        sys.exit(1)

    # Определяем смету: по set_id (если передан) или последняя approved
    est_set = None
    set_id = getattr(args, "set_id", None)
    if set_id:
        est_set = mes.execute("SELECT * FROM estimate_sets WHERE id = ?", (set_id,)).fetchone()
    if not est_set:
        est_set = mes.execute(
            "SELECT * FROM estimate_sets WHERE order_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1",
            (order["id"],)
        ).fetchone()
    if not est_set:
        est_set = mes.execute(
            # порядок как orders._active_set: основная (выбор Юры) перебивает дату
            "SELECT * FROM estimate_sets WHERE order_id = ? "
            "ORDER BY CASE status WHEN 'superseded' THEN 1 ELSE 0 END, "
            "COALESCE(is_primary,0) DESC, created_at DESC LIMIT 1",
            (order["id"],)
        ).fetchone()

    items = []
    if est_set:
        is_bank      = est_set["payment_type"] == "bank"
        # Дефолт как у остальной Фирмы (money.client_price, estimates.totals_from_items):
        # пусто → 13%, а явный 0 остаётся нулём. Было `or 13.0` — смета с 0% давала
        # в счёте +15%, хотя в самой смете и в КП удержания не было (ревью 04.08.2026).
        set_bank_pct = est_set["bank_pct"] if est_set["bank_pct"] is not None else 13.0

        items_raw = mes.execute(
            "SELECT * FROM estimate_items WHERE set_id = ? ORDER BY sort_order",
            (est_set["id"],)
        ).fetchall()

        for r in items_raw:
            sale_price = r["sale_price"] or 0
            qty        = r["quantity"] or 1
            # Безнал: 13% удерживаются ИЗ суммы счёта — делим, а не умножаем, и
            # округляем вверх до 100 ₽. Единая формула с firma: backend/money.py
            # (правило Юры 27.07.2026). Процент берём у СМЕТЫ: позиционный bank_pct
            # в данных содержит мусор.
            total_client = round(client_price(sale_price, "bank" if is_bank else "cash",
                                              set_bank_pct))
            unit_price = round(total_client / qty) if qty else total_client
            items.append({
                "name":  r["title"] or "Без названия",
                "qty":   qty,
                "unit":  "шт",
                "price": unit_price,
                "vat":   "Без НДС",
            })

    if not items:
        items = [{
            "name":  order["title"] or f"Работы по заказу {args.order}",
            "qty":   1,
            "unit":  "усл.",
            "price": order["price_plan"] or 0,
            "vat":   "Без НДС",
        }]

    client_inn  = order["client_inn"] or ""
    client_name = order["client_full"] or order["client_name"] or ""

    data = {
        "invoice_num":  args.num or next_invoice_num(),
        "invoice_date": ru_date(),
        "bank":  args.bank,
        "logo":  args.logo if getattr(args, "logo_explicit", False) else
                 ("mera" if (order["brand"] or "").lower() in ("mera", "мера") else "pbpb"),
        "buyer": {
            "name":    client_name,
            "inn":     client_inn,
            "address": "",
        },
        "items": items,
    }

    out  = OUTPUT_DIR / f"invoice_{args.order}_{data['invoice_num']}.pdf"
    html = build_html(data)
    html_to_pdf(html, out)
    print(f"[SEND_FILE:{out}]")
    print(f"Счет по заказу {args.order} сохранён: {out}")


def cmd_preview(args):
    """Тестовый счёт с демо-данными."""
    data = {
        "invoice_num":  "TEST-001",
        "invoice_date": ru_date(),
        "bank":  args.bank,
        "logo":  args.logo,
        "buyer": {
            "name":    'ООО "КЛИНИКА "ГОРОД ЗДОРОВЬЯ"',
            "inn":     "3666218213",
            "kpp":     "366601001",
            "address": "г Воронеж, ул Театральная, д 23/1, офис 301",
        },
        "items": [
            {"name": "Замена обивочного материала стулья", "qty": 7, "unit": "шт", "price": 3170, "vat": "Без НДС"},
        ],
    }
    out  = OUTPUT_DIR / f"invoice_preview_{args.bank}_{args.logo}.pdf"
    html = build_html(data)
    html_to_pdf(html, out)
    print(f"[SEND_FILE:{out}]")
    print(f"Превью сохранено: {out}")


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Генерация счёта на оплату")
    sub = parser.add_subparsers(dest="cmd")

    pv = sub.add_parser("preview", help="Тестовый счёт для проверки верстки")
    pv.add_argument("--bank", choices=["tbank", "sber"], default="tbank")
    pv.add_argument("--logo", choices=["pbpb", "mera"],  default="pbpb")

    gn = sub.add_parser("generate", help="Счёт из JSON-файла с данными")
    gn.add_argument("data", help="JSON с полями: invoice_num, buyer, items, bank, logo")

    oc = sub.add_parser("order", help="Счёт по заказу из MES")
    oc.add_argument("order",            help="Номер заказа, напр. ORD-005")
    oc.add_argument("--bank",   choices=["tbank", "sber"], default="tbank")
    oc.add_argument("--logo",   choices=["pbpb", "mera"],  default="pbpb")
    oc.add_argument("--num",    help="Номер счёта (по умолчанию — по дате)")
    oc.add_argument("--set-id", dest="set_id", default=None, help="ID сметы (estimate_set)")

    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        sys.exit(1)

    {"preview": cmd_preview, "generate": cmd_generate, "order": cmd_order}[args.cmd](args)


if __name__ == "__main__":
    main()
