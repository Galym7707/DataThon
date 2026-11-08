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


DEFAULT_CHECKLIST = [
    dict(id="01", name="Установление контакта", type="binary", weight=10, allow_na=True,
         description="Оператор поздоровался на языке клиента и представился в первом ответе. Представление с обезличенным именем засчитывается.",
         na_condition="Только для звонка: начало записи отсутствует, поэтому приветствие и представление невозможно проверить. Если первая реплика оператора с приветствием доступна, это исключение не применяется."),
    dict(id="02", name="Выявление потребности", type="binary", weight=15, allow_na=True,
         description="Сначала проверь условие N/A. Иначе Да — учёл известные детали и уточнил реально недостающие обстоятельства запроса до ответа; Нет — нужные уточнения пропущены. Проверка личности оценивается отдельно и сама по себе не является уточнением потребности.",
         na_condition="Суть запроса и данные для ответа или следующего шага уже были ясны до содержательного ответа оператора, дополнительные уточнения обстоятельств не требовались. Отсутствие подтверждённой личности само по себе не отменяет это условие — оно оценивается отдельно."),
    dict(id="03", name="Идентификация", type="binary", weight=20, allow_na=True,
         description="Проверка личности подтверждена до раскрытия персональных данных или защищённого действия. Новый индивидуальный статус или ограничение конкретного счёта относятся к защищённым данным. Если проверка требовалась, но не подтверждена, ответ Нет. Общие условные пояснения и повтор сведений самого клиента без обращения к его счёту не доказывают защищённое действие.",
         na_condition="Запрос не требовал идентификации (общая информация без защищённых действий)."),
    dict(id="04", name="Корректность и полнота консультации", type="scale", weight=20,
         max_scale=20, levels=[0, 5, 10, 15, 20], allow_na=True,
         description="20: все существенные вопросы закрыты ИЛИ для них дан корректный следующий шаг, включая передачу вопроса на проверку; 15: основной решён, пропущена второстепенная деталь; 10: часть запроса закрыта, существенный вопрос открыт без следующего шага; 5: общая подсказка без понятного действия; 0: нет ответа по существу или ключевая рекомендация ошибочна. Не снижай за отсутствие установленной причины, если для её выяснения предложена проверка; не требуй не заданных клиентом сроков/канала ответа. Но передача основного вопроса не закрывает проигнорированные дополнительные вопросы.",
         na_condition="Чат закончился до того, как клиент сформулировал запрос."),
    dict(id="05", name="Эмпатия и клиентоориентированность", type="binary", weight=15,
         description="Да: оператор вежлив И, если клиент выразил недовольство, опасение или описал неудобство, содержательно отреагировал на конкретную проблему. Нет: грубость ИЛИ проблема/опасение проигнорированы. Одной формальной вежливости при игнорировании неудобства недостаточно. Шаблонное извинение не обязательно."),
    dict(id="06", name="Управление диалогом и грамотность", type="scale", weight=15,
         max_scale=10, levels=[0, 4, 7, 10],
         description="0: из-за бессвязных или противоречивых реплик ход диалога непонятен; 4: клиенту приходится переспрашивать из-за формулировок или порядка, в том числе повторять исходный вопрос после ухода оператора в сторону; 7: один заметный сбой, но ответ понятен; 10: ясно и связно, при явном ожидании предупредил. Порог первой реакции в 3 минуты, теги и вложения НЕ учитываются; норматив удержания на линии не задан. Обещание будущего ответа после передачи специалистам не равно удержанию без предупреждения. Сам новый вопрос не означает сбой общения."),
    dict(id="07", name="Завершение", type="binary", weight=5, allow_na=True,
         description="Да только при сочетании (итог ИЛИ предложение дальнейшей помощи) И прощания в завершении. Итогом считается и сообщение о следующем шаге с запросом. Например, передача вопроса на проверку + прощание = Да, даже без предложения ещё помочь. Только благодарность/пожелание хорошего дня/прощание без итога или предложения помощи = Нет. Проверяй последнюю реплику целиком.",
         na_condition="Диалог оборвался до возможности его завершить."),
    dict(id="08", name="Грубые ошибки", type="flag", weight=0,
         description="Да, если оператор оскорбил клиента, предложил платную услугу в обход компании (личный перевод для инвестирования / частная платная консультация) или раскрыл конфиденциальные данные. Индивидуальный статус или ограничение конкретного счёта, сообщённые без подтверждённой личности, считаются конфиденциальным раскрытием; общая информация о продукте — нет. Для обходной услуги достаточно предложения, согласие клиента не нужно. Отдельный флаг, итог не обнуляется."),
]


def default_checklist():
    return [Criterion(**c).model_dump() for c in DEFAULT_CHECKLIST]


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
