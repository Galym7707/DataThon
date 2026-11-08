"""Deterministic checklist validation and scoring; no network or LLM arithmetic."""
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Criterion(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, validate_default=True)
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=2500)
    type: Literal["binary", "scale", "flag"]
    weight: float = Field(ge=0, le=10000, strict=True)
    max_scale: float = Field(default=1, gt=0, le=10000, strict=True)
    levels: list[Annotated[float, Field(strict=True)]] = Field(default_factory=list, max_length=50)
    allow_na: bool = Field(default=False, strict=True)
    na_condition: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def check(self):
        self.name = self.name.strip()
        self.description = self.description.strip()
        self.na_condition = self.na_condition.strip()
        if not self.name or not self.description:
            raise ValueError("Название и правило не должны быть пустыми")
        if self.allow_na and not self.na_condition.strip():
            raise ValueError("Для N/A нужно условие неприменимости")
        if self.type == "flag" and (self.weight != 0 or self.allow_na):
            raise ValueError("Флаг должен иметь вес 0 и не допускает N/A")
        if self.type != "scale" and self.max_scale != 1:
            raise ValueError("Для бинарного критерия max_scale = 1")
        if self.type == "scale":
            if not self.levels or len(set(self.levels)) != len(self.levels):
                raise ValueError("Укажите уникальные ступени шкалы")
            if min(self.levels) != 0 or max(self.levels) != self.max_scale:
                raise ValueError("Шкала должна включать 0 и max_scale")
            if any(not 0 <= n <= self.max_scale for n in self.levels):
                raise ValueError("Недопустимая ступень шкалы")
        elif self.levels:
            raise ValueError("Ступени разрешены только для шкалы")
        return self


class ChecklistUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    criteria: list[Criterion] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({c.id for c in self.criteria}) != len(self.criteria):
            raise ValueError("ID критериев должны быть уникальны")
        return self


LEGACY_CLOSURE_DESCRIPTION = "Подвёл итог ИЛИ предложил дальнейшую помощь, И попрощался."
CLOSURE_DESCRIPTION = (
    "Да — в завершающем обмене оператор подвёл содержательный итог или предложил дальнейшую помощь, "
    "И попрощался. Нет — отсутствует хотя бы один из этих двух элементов. "
    "«Пожалуйста. Хорошего вечера!», «Спасибо за обращение. До свидания!», «Рад помочь. Хорошего дня!» "
    "сами по себе означают Нет: это вежливость и прощание, без итога или предложения помощи. "
    "«Рад помочь» не равно «Могу ещё чем-то помочь?». Обычная консультация до ответа клиента «спасибо» "
    "не становится итогом автоматически. Итог/предложение помощи и прощание могут быть в соседних "
    "репликах оператора с ответом клиента между ними."
)

DEFAULT_CHECKLIST = [
    dict(id="01", name="Установление контакта", type="binary", weight=10,
         description="Оператор поздоровался на языке клиента и представился в первом ответе."),
    dict(id="02", name="Выявление потребности", type="binary", weight=15, allow_na=True,
         description="Учёл известные детали и уточнил недостающее до ответа.",
         na_condition="Данных для ответа хватало с самого начала."),
    dict(id="03", name="Идентификация", type="binary", weight=20, allow_na=True,
         description="Проверка личности подтверждена до раскрытия персональных данных или защищённого действия. Если требовалась, но не подтверждена, ответ Нет.",
         na_condition="Запрос не требовал идентификации (общая информация без защищённых действий)."),
    dict(id="04", name="Корректность и полнота консультации", type="scale", weight=20,
         max_scale=20, levels=[0, 5, 10, 15, 20], allow_na=True,
         description="20: все существенные вопросы закрыты или дан корректный следующий шаг; 15: основной решён, пропущена второстепенная деталь; 10: существенный вопрос открыт; 5: общая подсказка без понятного действия; 0: нет ответа по существу или ключевая рекомендация ошибочна.",
         na_condition="Чат закончился до того, как клиент сформулировал запрос."),
    dict(id="05", name="Эмпатия и клиентоориентированность", type="binary", weight=15,
         description="Вежливость и реакция на конкретную проблему, если клиент выразил недовольство или описал неудобство."),
    dict(id="06", name="Управление диалогом и грамотность", type="scale", weight=15,
         max_scale=10, levels=[0, 4, 7, 10],
         description="10: ясно и связно, при явном ожидании предупредил; 7: один заметный сбой, но ответ понятен; 4: клиент переспрашивает из-за формулировок или порядка; 0: бессвязно или противоречиво. Порог первой реакции 3 минуты, теги и вложения в оценку не входят."),
    dict(id="07", name="Завершение", type="binary", weight=5, allow_na=True,
         description=CLOSURE_DESCRIPTION,
         na_condition="Диалог оборвался до возможности его завершить."),
    dict(id="08", name="Грубые ошибки", type="flag", weight=0,
         description="Да, если оператор оскорбил клиента, предложил платную услугу в обход компании (личный перевод для инвестирования / частная платная консультация) или раскрыл конфиденциальные данные. Предложения достаточно, согласие клиента не нужно. Отдельный флаг, итог не обнуляется."),
]


def default_checklist():
    return [Criterion(**c).model_dump() for c in DEFAULT_CHECKLIST]


def upgrade_default_closure(criteria):
    """Clarify the original rule while preserving custom rules and weights."""
    current = next(c for c in default_checklist() if c["id"] == "07")
    legacy = {**current, "description": LEGACY_CLOSURE_DESCRIPTION}
    for criterion in criteria:
        if all(criterion.get(k) == v for k, v in legacy.items() if k != "weight"):
            criterion["description"] = current["description"]
            return True
    return False


def validate_value(criterion, value, is_na):
    if type(is_na) is not bool:
        raise ValueError("is_na должен быть boolean")
    if is_na:
        if not criterion["allow_na"] or value is not None:
            raise ValueError("N/A запрещён или содержит числовое значение")
        return
    if type(value) not in (int, float):
        raise ValueError("Нужна числовая оценка")
    allowed = criterion["levels"] if criterion["type"] == "scale" else [0, 1]
    if value not in allowed:
        raise ValueError(f"Недопустимая оценка для {criterion['id']}: {value}")


def score_evaluation(criteria, results):
    """Round only the total, after exact Decimal weight redistribution."""
    lookup = {r["criterion_id"]: r for r in results}
    if len(lookup) != len(results) or set(lookup) != {c["id"] for c in criteria}:
        raise ValueError("Нужен ровно один результат для каждого критерия")
    for c in criteria:
        r = lookup[c["id"]]
        validate_value(c, r["value"], r["is_na"])
    denominator = sum((Decimal(str(c["weight"])) for c in criteria
                       if not lookup[c["id"]]["is_na"] and c["type"] != "flag"), Decimal(0))
    total = Decimal(0)
    breakdown = []
    violation = False
    for c in criteria:
        r = lookup[c["id"]]
        weight = Decimal(0)
        earned = Decimal(0)
        if c["type"] == "flag":
            violation |= r["value"] == 1
        elif not r["is_na"] and denominator:
            weight = Decimal(str(c["weight"])) / denominator * 100
            maximum = Decimal(str(c["max_scale"])) if c["type"] == "scale" else Decimal(1)
            earned = Decimal(str(r["value"])) / maximum * weight
            total += earned
        breakdown.append({**r, "name": c["name"], "type": c["type"], "weight": c["weight"],
                          "max_scale": c["max_scale"], "normalized_weight": float(weight),
                          "earned_score": float(earned)})
    return {"final_score": float(total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)) if denominator else None,
            "applicable_weight": float(denominator), "has_gross_violation": violation,
            "criteria": breakdown}
