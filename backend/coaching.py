"""Recommendations for current failed criteria; old evaluations remain usable."""
from .scoring_engine import default_checklist

RULE_GUIDANCE = {
    "01": ("Начните ответ с приветствия на языке клиента и представьтесь.",
           "Напишите первое сообщение клиенту: поздоровайтесь и представьтесь."),
    "02": ("Используйте уже известные детали и уточните недостающую информацию до консультации.",
           "Напишите ответ с уточняющим вопросом, который поможет решить запрос клиента."),
    "03": ("До обсуждения персональных данных подтвердите идентификацию. Не придумывайте способ проверки.",
           "Напишите безопасный ответ: объясните необходимость проверки личности перед защищённым действием."),
    "04": ("Ответьте на каждый вопрос клиента и укажите понятный следующий шаг. Не обещайте неподтверждённые сроки.",
           "Перепишите ответ так, чтобы закрыть все вопросы клиента из ситуации и объяснить дальнейшие действия."),
    "05": ("Признайте конкретное неудобство клиента и предложите помощь без формального или обвиняющего тона.",
           "Напишите вежливый ответ, учитывающий конкретную проблему и состояние клиента."),
    "06": ("Изложите действия по порядку и простыми словами. Если требуется ожидание, предупредите об этом.",
           "Перепишите ответ ясно и последовательно, сохраняя только подтверждённые сведения."),
    "07": ("Перед прощанием подведите итог или предложите дальнейшую помощь. Одного прощания недостаточно.",
           "Напишите завершающий ответ: подведите итог или предложите помощь, затем попрощайтесь."),
    "08": ("Замените проблемную реплику на уважительный и безопасный ответ в рамках правила. Не раскрывайте закрытые данные.",
           "Перепишите проблемный ответ так, чтобы устранить указанное нарушение и помочь клиенту."),
}
GENERIC_GUIDANCE = (
    "Исправьте указанную ошибку, следуя действующему правилу критерия. Используйте только сведения из диалога.",
    "Напишите новый ответ для этой ситуации с учётом ошибки и правила критерия.",
)


def needs_practice(criterion, result):
    if result.get("is_na") or result.get("value") is None:
        return False
    if criterion["type"] == "flag":
        return result["value"] == 1
    return result["value"] < (criterion["max_scale"] if criterion["type"] == "scale" else 1)


def guidance(criterion, result):
    if result.get("recommendation") and result.get("practice_task") and not result.get("override_comment"):
        return result["recommendation"], result["practice_task"], "ai"
    # Do not attach a default instruction to a customized rule that reused its ID.
    baseline = next((c for c in default_checklist() if c["id"] == criterion["id"]), None)
    equivalent = baseline and all(criterion.get(k) == baseline.get(k) for k in baseline if k != "weight")
    rec, task = RULE_GUIDANCE.get(criterion["id"], GENERIC_GUIDANCE) if equivalent else GENERIC_GUIDANCE
    return rec, task, "rule"


def recommendations(evaluation, criteria):
    results = {r["criterion_id"]: r for r in evaluation["results"]}
    items = []
    for c in criteria:
        r = results[c["id"]]
        if not needs_practice(c, r):
            continue
        rec, task, source = guidance(c, r)
        items.append({"criterion_id": c["id"], "name": c["name"], "recommendation": rec,
                      "task": task, "source": source, "issue": r.get("override_comment") or r["reason"],
                      **{k: r[k] for k in ("proof_message_index", "proof_timestamp", "proof_quote")}})
    return items
