"""Генерация счёта и КП из сметы (routers/estimates.py).

Инцидент 03.08.2026: кнопка «Сгенерировать счёт» отдавала чужой PDF — путь
результата искался глобом по АРХИВУ фин-агента вместо разбора stdout генератора
(он печатает точный путь маркером [SEND_FILE:...]).
"""
import pytest
from fastapi import HTTPException

from routers.estimates import _extract_pdf_path, _kp_args


class TestExtractPdfPath:
    def test_путь_из_маркера_send_file(self):
        out = ("строки лога\n"
               "[SEND_FILE:/opt/firma/data/invoices/invoice_ORD-035_7011.pdf]\n"
               "Счет по заказу ORD-035 сохранён: ...")
        assert _extract_pdf_path(out) == "/opt/firma/data/invoices/invoice_ORD-035_7011.pdf"

    def test_без_маркера_возвращает_none(self):
        assert _extract_pdf_path("что-то пошло не так") is None

    def test_пустой_вывод(self):
        assert _extract_pdf_path("") is None


class TestKpArgs:
    def _item(self, title, qty, sale):
        return {"title": title, "quantity": qty, "sale_price": sale}

    def test_позиции_собираются_в_item_аргументы(self):
        args = _kp_args(
            {"payment_type": "cash", "bank_pct": 0},
            [self._item("Башня шестигранник", 1, 130_000),
             self._item("Секция-лепесток", 8, 432_000)],
            brand="MeRA", title="МАФ для СТК", out_path="/tmp/kp.pdf",
        )
        assert "--logo" in args and args[args.index("--logo") + 1] == "mera"
        items = [args[i + 1] for i, a in enumerate(args) if a == "--item"]
        assert items[0] == "Башня шестигранник:1:::130000"
        assert items[1] == "Секция-лепесток:8:::54000"   # цена клиенту ЗА ШТУКУ
        assert args[args.index("--output") + 1] == "/tmp/kp.pdf"
        assert "--send" not in args

    def test_двоеточие_в_названии_не_ломает_формат(self):
        args = _kp_args({"payment_type": "cash", "bank_pct": 0},
                        [self._item("Стол 100:70", 1, 10_000)],
                        brand=None, title="t", out_path="/tmp/kp.pdf")
        item = args[args.index("--item") + 1]
        assert item.count(":") == 4          # ровно разделители формата
        assert "100∶70" in item              # двоеточие названия заменено

    def test_безнал_цена_за_штуку_с_удержанием(self):
        # sale 87 000 «за нал» × безнал 13% → клиенту 100 000, за штуку 50 000
        args = _kp_args({"payment_type": "bank", "bank_pct": 13.0},
                        [self._item("Изделие", 2, 87_000)],
                        brand="pbpb", title="t", out_path="/tmp/kp.pdf")
        item = args[args.index("--item") + 1]
        assert item == "Изделие:2:::50000"

    def test_пустая_смета_это_400(self):
        with pytest.raises(HTTPException) as e:
            _kp_args({"payment_type": "cash", "bank_pct": 0}, [],
                     brand=None, title="t", out_path="/tmp/kp.pdf")
        assert e.value.status_code == 400
