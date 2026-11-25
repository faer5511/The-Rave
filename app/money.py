"""Чистые функции без зависимостей (легко тестировать). Деньги — в копейках."""


def calc_discount(kind: str, value: int, subtotal: int) -> int:
    """percent: целые рубли вниз; fixed: value копеек. Скидка не больше суммы заказа."""
    if subtotal <= 0:
        return 0
    if kind == "percent":
        return min(subtotal, (subtotal * min(value, 100) // 100) // 100 * 100)
    return min(value, subtotal)


def amount_str(kopecks: int) -> str:
    return "%d.%02d" % (kopecks // 100, kopecks % 100)
