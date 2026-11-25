"""Платёжные провайдеры. mock — для разработки, yookassa — встроенный виджет (embedded)."""

import base64
import json
import secrets
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from .config import settings
from .money import amount_str


class PaymentError(Exception):
    pass


class MockProvider:
    name = "mock"

    def create_payment(self, order, return_url: str, idem: str) -> Dict[str, Any]:
        return {
            "id": "mock_" + secrets.token_hex(8),
            "status": "pending",
            "confirmation": {"type": "mock", "confirmation_token": ""},
        }

    def get_payment(self, payment_id: str) -> Optional[Dict[str, Any]]:
        return None


class YooKassaProvider:
    name = "yookassa"
    API = "https://api.yookassa.ru/v3"

    def _call(
        self,
        method: str,
        path: str,
        body: Optional[dict] = None,
        idem: Optional[str] = None,
    ):
        if not (settings.yookassa_shop_id and settings.yookassa_secret_key):
            raise PaymentError("Не заданы YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY")
        token = base64.b64encode(
            (
                "%s:%s" % (settings.yookassa_shop_id, settings.yookassa_secret_key)
            ).encode()
        ).decode()
        headers = {
            "Authorization": "Basic " + token,
            "Content-Type": "application/json",
        }
        if idem:
            headers["Idempotence-Key"] = idem
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.API + path, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            raise PaymentError("YooKassa %s: %s" % (e.code, e.read().decode()[:300]))
        except Exception as e:  # сеть, таймаут
            raise PaymentError(str(e))

    def create_payment(self, order, return_url: str, idem: str) -> Dict[str, Any]:
        body = {
            "amount": {"value": amount_str(order.total), "currency": "RUB"},
            "capture": True,
            "confirmation": {"type": "embedded"},  # виджет внутри сайта, без редиректа
            "description": "THE RAVE, заказ %s" % order.id[:8],
            "metadata": {"order_id": order.id},
        }
        if settings.yookassa_send_receipt:
            if (
                order.discount
            ):  # со скидкой сумма позиций должна совпасть с итогом — одна строка
                lines = [("Билеты THE RAVE", 1, order.total)]
            else:
                lines = [
                    (i.category_name, i.quantity, i.unit_price) for i in order.items
                ]
            body["receipt"] = {
                "customer": {"email": order.email, "phone": order.phone.lstrip("+")},
                "items": [
                    {
                        "description": d[:128],
                        "quantity": str(q),
                        "amount": {"value": amount_str(p), "currency": "RUB"},
                        "vat_code": 1,
                        "payment_mode": "full_payment",
                        "payment_subject": "service",
                    }
                    for d, q, p in lines
                ],
            }
        return self._call("POST", "/payments", body, idem)

    def get_payment(self, payment_id: str) -> Optional[Dict[str, Any]]:
        return self._call("GET", "/payments/" + payment_id)


def get_provider():
    return MockProvider() if settings.payment_mode == "mock" else YooKassaProvider()
