"""Compare every criterion with a frozen manual review; not a ground-truth benchmark."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manual", type=Path, required=True)
    parser.add_argument("--runs", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manual = json.loads(args.manual.read_text(encoding="utf-8"))["reviews"]
    runs = []
    for path in args.runs:
        data = json.loads(path.read_text(encoding="utf-8"))
        runs.append((path.stem, {r["conversation_id"]: r for r in data["results"]}))
    rows = []
    summary = []
    for name, run in runs:
        compared = matched = completed = 0
        for review in manual:
            response = run.get(review["conversation_id"], {})
            evaluation = response.get("evaluation")
            if not evaluation:
                continue
            completed += 1
            values = {c["criterion_id"]: c["value"] for c in evaluation["criteria"]}
            for criterion in review["criteria"]:
                compared += 1
                matched += values.get(criterion["criterion_id"], "missing") == criterion["value"]
        summary.append({"run": name, "completed": completed, "dialogs": len(manual),
                        "matched": matched, "compared": compared,
                        "agreement_percent": round(100 * matched / compared, 2) if compared else None})
    lines = ["# Сравнение с ручной оценкой", "",
             "Ручные оценки выставлены ассистентом до соответствующего прогона. Это проверка согласованности инструкций, не официальный эталон и не измерение точности на независимой разметке.", "",
             "| Прогон | Успешные диалоги | Совпадения критериев | Согласие |",
             "|---|---|---|---|"]
    for item in summary:
        percent = str(item["agreement_percent"]).replace(".", ",")
        lines.append(f"| {item['run']} | {item['completed']}/{item['dialogs']} | {item['matched']}/{item['compared']} | {percent}% |")
    def display(value):
        return "N/A" if value is None else str(value)
    for review in manual:
        cid = review["conversation_id"]
        lines.extend(["", f"## {cid}", "", "| Критерий | Вручную | " + " | ".join(n for n, _ in runs) + " |", "|---|---|" + "---|" * len(runs)])
        for criterion in review["criteria"]:
            row = {"conversation_id": cid, "criterion_id": criterion["criterion_id"],
                   "manual_value": criterion["value"], "manual_reason": criterion["reason"], "runs": {}}
            cells = []
            for name, run in runs:
                response = run.get(cid, {})
                values = {c["criterion_id"]: c for c in response.get("evaluation", {}).get("criteria", [])}
                result = values.get(criterion["criterion_id"])
                row["runs"][name] = result or {"error": response.get("detail", "Нет результата")}
                if result:
                    marker = "=" if result["value"] == criterion["value"] else "≠"
                    cells.append(display(result["value"]) + " " + marker)
                else:
                    cells.append("ошибка обработки")
            rows.append(row)
            lines.append(f"| {criterion['criterion_id']} | {display(criterion['value'])} | " + " | ".join(cells) + " |")
    for review in manual:
        for criterion in review['criteria']:
            if 'acceptable_values' in criterion:
                lines.extend(["", f"Для {review['conversation_id']} / {criterion['criterion_id']} основной ручной ответ: {display(criterion['value'])}; заранее признаны допустимыми трактовки {criterion['acceptable_values']}. Строгое согласие выше рассчитано с основным ответом."])
    lines.append("")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines), encoding="utf-8")
    args.output.with_suffix(".json").write_text(json.dumps({"summary": summary, "criteria": rows}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
