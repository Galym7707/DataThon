/* Translate interface copy only. Conversation text, evidence and edited rules stay original. */
(() => {
  'use strict';
  const rows = `
Последняя проверка не завершена|Соңғы тексеру аяқталмады|The last evaluation did not complete
Цитата ИИ не совпала с текстом указанных реплик. Оценка не сохранена.|ЖИ дәйексөзі көрсетілген репликалар мәтініне сәйкес келмеді. Баға сақталмады.|The AI quote did not match the cited messages. No evaluation was saved.
Время цитаты ИИ не совпало с исходной репликой. Оценка не сохранена.|ЖИ дәйексөзінің уақыты бастапқы репликаға сәйкес келмеді. Баға сақталмады.|The AI quote timestamp did not match the source message. No evaluation was saved.
ИИ указал некорректные номера реплик. Оценка не сохранена.|ЖИ реплика нөмірлерін қате көрсетті. Баға сақталмады.|The AI supplied invalid message numbers. No evaluation was saved.
ИИ вернул незавершённый ответ или отказался от оценки. Результат не сохранён.|ЖИ толық жауап бермеді немесе бағалаудан бас тартты. Нәтиже сақталмады.|The AI returned an incomplete response or declined to evaluate. No result was saved.
В ответе ИИ нет рекомендации по выявленной ошибке. Оценка не сохранена.|ЖИ жауабында анықталған қате бойынша ұсыныс жоқ. Баға сақталмады.|The AI response has no recommendation for an identified issue. No evaluation was saved.
Рекомендация ИИ противоречит выставленной оценке. Результат не сохранён.|ЖИ ұсынысы қойылған бағаға қайшы келеді. Нәтиже сақталмады.|The AI recommendation contradicts its evaluation. No result was saved.
Не удалось связать цитату ИИ с исходной перепиской. Оценка не сохранена.|ЖИ дәйексөзін бастапқы хат алмасумен байланыстыру мүмкін болмады. Баға сақталмады.|The AI quote could not be linked to the original conversation. No evaluation was saved.
Ответ ИИ не прошёл проверку формата. Оценка не сохранена.|ЖИ жауабы пішім тексеруінен өтпеді. Баға сақталмады.|The AI response failed format validation. No evaluation was saved.
Не удалось получить ответ AI-провайдера. Проверьте подключение и доступность API.|AI провайдерінің жауабы алынбады. Байланысты және API қолжетімділігін тексеріңіз.|No response was received from the AI provider. Check the connection and API availability.
AI-провайдер отклонил параметры запроса. Оценка не выполнена; требуется проверить формат запроса.|AI провайдері сұрау параметрлерін қабылдамады. Бағалау орындалмады; сұрау пішімін тексеру қажет.|The AI provider rejected the request parameters. No evaluation was saved; the request format needs to be checked.
Схема ответа AI превышает допустимую сложность. Упростите шкалы чек-листа; запрос не отправлен.|AI жауабының схемасы рұқсат етілген күрделіліктен асады. Чек-лист шкалаларын жеңілдетіңіз; сұрау жіберілмеді.|The AI response schema exceeds the supported complexity. Simplify the checklist scales; no request was sent.
Не удалось проверить подготовленный запрос. Подготовьте новое превью.|Дайындалған сұрауды тексеру мүмкін болмады. Жаңа алдын ала көрініс дайындаңыз.|The prepared request could not be verified. Prepare a new preview.
Не удалось завершить проверку. Оценка не сохранена.|Тексеруді аяқтау мүмкін болмады. Баға сақталмады.|The evaluation could not be completed. No evaluation was saved.
Предыдущая попытка оценки завершилась ошибкой. Подробная причина не была сохранена.|Алдыңғы бағалау әрекеті қате аяқталды. Толық себебі сақталмаған.|The previous evaluation failed. Its detailed reason was not saved.
Действие недоступно для этой роли|Бұл рөлге әрекет қолжетімсіз|This action is unavailable for your role
Нужен токен QA-супервизора|Сапаны бақылау басшысының токені қажет|A QA supervisor token is required

Проверенный ответ|Тексерілген жауап|Reviewed response
Предыдущие сообщения|Алдыңғы хабарламалар|Earlier messages
Для практики нужна актуальная оценка диалога.|Жаттығу үшін диалогтың ағымдағы бағасы қажет.|Practice requires a current conversation evaluation.
По этому критерию нет актуальной ошибки для практики.|Бұл критерий бойынша жаттығуға арналған ағымдағы қате жоқ.|There is no current issue to practice for this criterion.
Напишите новый ответ для проверки.|Тексеру үшін жаңа жауап жазыңыз.|Write a new response to check.
Оценка или правило изменились. Откройте упражнение заново.|Бағалау немесе ереже өзгерді. Жаттығуды қайта ашыңыз.|The evaluation or rule has changed. Reopen the exercise.
Идентификатор попытки уже использован для другого ответа.|Әрекет идентификаторы басқа жауап үшін қолданылған.|This attempt ID has already been used for another response.
Эта проверка уже запущена. Дождитесь результата или откройте упражнение заново.|Бұл тексеру басталған. Нәтижені күтіңіз немесе жаттығуды қайта ашыңыз.|This check has already started. Wait for the result or reopen the exercise.
Упражнение уже проверяется. Дождитесь результата.|Жаттығу тексерілуде. Нәтижені күтіңіз.|This exercise is being checked. Wait for the result.
Проверка практики недоступна: ключ ИИ не настроен.|Жаттығуды тексеру қолжетімсіз: ЖИ кілті бапталмаған.|Practice checking is unavailable: the AI key is not configured.
Не удалось проверить упражнение. Попытка учтена в лимите; ответ сохранён в форме.|Жаттығуды тексеру мүмкін болмады. Әрекет лимитке есептелді; жауап формада сақталған.|The exercise could not be checked. The attempt counted against your limit; your response remains in the form.

Как улучшить ответ|Жауапты қалай жақсартуға болады|How to improve the response
Отработать навык|Дағдыны пысықтау|Practice this skill
ПРАКТИКА НАВЫКА|ДАҒДЫНЫ ПЫСЫҚТАУ|SKILL PRACTICE
Загрузка упражнения…|Жаттығу жүктелуде…|Loading exercise…
Потренируйте ответ на реальной ситуации. Исходная оценка диалога не меняется.|Нақты жағдайға жауап беруді пысықтаңыз. Диалогтың бастапқы бағасы өзгермейді.|Practice your response to a real situation. The original conversation score stays unchanged.
Ситуация из диалога|Диалогтағы жағдай|Conversation context
Задание|Тапсырма|Your task
Рекомендация и критерий|Ұсыныс пен критерий|Guidance and criterion
Ваш вариант ответа|Сіздің жауап нұсқаңыз|Your response
Напишите, как вы ответили бы клиенту в этой ситуации…|Осы жағдайда клиентке қалай жауап беретініңізді жазыңыз…|Write how you would respond to the customer in this situation…
Используйте детали диалога. Не придумывайте факты, сроки или обещания.|Диалогтағы мәліметтерді қолданыңыз. Фактілерді, мерзімдерді немесе уәделерді ойдан шығармаңыз.|Use the details in the conversation. Do not invent facts, deadlines or promises.
Проверить ответ|Жауапты тексеру|Check response
Проверяем ответ…|Жауап тексерілуде…|Checking response…
Этот ответ уже проверен. Повторная проверка не расходует запрос.|Бұл жауап тексерілген. Қайта тексеру сұрауды жұмсамайды.|This response was already checked. Checking it again uses no new request.
Одна проверка ответа — 1 запрос к ИИ.|Бір жауапты тексеру — ЖИ-ге 1 сұрау.|One response check uses 1 AI request.
Проверяем ответ. Можно закрыть окно: результат сохранится в истории.|Жауап тексерілуде. Терезені жабуға болады: нәтиже тарихта сақталады.|Checking your response. You can close this window; the result will be saved in history.
Открытие упражнения не расходует запросы.|Жаттығуды ашу сұрауларды жұмсамайды.|Opening an exercise uses no AI requests.
Закройте упражнение и обновите диалог перед новой попыткой.|Жаңа әрекет алдында жаттығуды жауып, диалогты жаңартыңыз.|Close this exercise and refresh the conversation before trying again.
Проверка ответа недоступна. Обратитесь к администратору.|Жауапты тексеру қолжетімсіз. Әкімшіге хабарласыңыз.|Response checking is unavailable. Contact your administrator.
Упражнение выполнено|Жаттығу орындалды|Exercise completed
Нужно доработать|Жетілдіру қажет|Needs improvement
Что получилось|Не сәтті шықты|What worked
Что улучшить|Нені жақсарту керек|What to improve
Почему|Неліктен|Why
Доработать ответ|Жауапты жетілдіру|Revise response
Предыдущие попытки|Алдыңғы әрекеттер|Previous attempts
Ваш ответ|Сіздің жауабыңыз|Your response
Сохранённая проверка · новый запрос не использован|Сақталған тексеру · жаңа сұрау жұмсалған жоқ|Saved feedback · no new request used
На основе правил|Ережелер негізінде|Based on rules
По результатам оценки|Бағалау нәтижелері бойынша|Based on evaluation
Оценка изменилась. Закройте упражнение и обновите диалог.|Бағалау өзгерді. Жаттығуды жауып, диалогты жаңартыңыз.|The evaluation has changed. Close the exercise and refresh the conversation.
Начните ответ с приветствия на языке клиента и представьтесь.|Жауапты клиент тілінде амандасудан бастап, өзіңізді таныстырыңыз.|Begin with a greeting in the customer's language and introduce yourself.
Напишите первое сообщение клиенту: поздоровайтесь и представьтесь.|Клиентке алғашқы хабарламаны жазыңыз: амандасып, өзіңізді таныстырыңыз.|Write your first message to the customer: greet them and introduce yourself.
Используйте уже известные детали и уточните недостающую информацию до консультации.|Кеңес бермес бұрын белгілі мәліметтерді қолданып, жетіспейтін ақпаратты нақтылаңыз.|Use the details already available and clarify any missing information before advising.
Напишите ответ с уточняющим вопросом, который поможет решить запрос клиента.|Клиенттің сұрауын шешуге көмектесетін нақтылаушы сұрағы бар жауап жазыңыз.|Write a response with a clarifying question that helps resolve the customer's request.
До обсуждения персональных данных подтвердите идентификацию. Не придумывайте способ проверки.|Жеке деректерді талқыламас бұрын сәйкестендіруді растаңыз. Тексеру тәсілін ойдан шығармаңыз.|Confirm identity verification before discussing personal data. Do not invent a verification method.
Напишите безопасный ответ: объясните необходимость проверки личности перед защищённым действием.|Қауіпсіз жауап жазыңыз: қорғалған әрекет алдында тұлғаны тексеру қажеттігін түсіндіріңіз.|Write a safe response explaining why identity verification is needed before a protected action.
Ответьте на каждый вопрос клиента и укажите понятный следующий шаг. Не обещайте неподтверждённые сроки.|Клиенттің әр сұрағына жауап беріп, келесі қадамды түсінікті көрсетіңіз. Расталмаған мерзімдерді уәде етпеңіз.|Address each customer question and give a clear next step. Do not promise unconfirmed deadlines.
Перепишите ответ так, чтобы закрыть все вопросы клиента из ситуации и объяснить дальнейшие действия.|Осы жағдайдағы клиенттің барлық сұрақтарына жауап беріп, келесі әрекеттерді түсіндіретіндей жауапты қайта жазыңыз.|Rewrite the response to address every customer question in this situation and explain the next steps.
Признайте конкретное неудобство клиента и предложите помощь без формального или обвиняющего тона.|Клиенттің нақты қолайсыздығын мойындап, ресми немесе айыптаушы реңксіз көмек ұсыныңыз.|Acknowledge the customer's specific inconvenience and offer help without sounding mechanical or accusatory.
Напишите вежливый ответ, учитывающий конкретную проблему и состояние клиента.|Клиенттің нақты мәселесі мен жағдайын ескеретін сыпайы жауап жазыңыз.|Write a polite response that addresses the customer's specific problem and feelings.
Изложите действия по порядку и простыми словами. Если требуется ожидание, предупредите об этом.|Әрекеттерді ретімен және қарапайым сөздермен түсіндіріңіз. Күту қажет болса, ескертіңіз.|Explain the steps in order using plain language. Let the customer know if they need to wait.
Перепишите ответ ясно и последовательно, сохраняя только подтверждённые сведения.|Тек расталған мәліметтерді сақтап, жауапты анық және жүйелі түрде қайта жазыңыз.|Rewrite the response clearly and in order, using only confirmed information.
Перед прощанием подведите итог или предложите дальнейшую помощь. Одного прощания недостаточно.|Қоштаспас бұрын қорытынды жасаңыз немесе қосымша көмек ұсыныңыз. Тек қоштасу жеткіліксіз.|Before saying goodbye, summarize the outcome or offer further help. A goodbye alone is not enough.
Напишите завершающий ответ: подведите итог или предложите помощь, затем попрощайтесь.|Қорытынды жауап жазыңыз: түйін жасаңыз не көмек ұсыныңыз, содан кейін қоштасыңыз.|Write a closing response: summarize or offer help, then say goodbye.
Замените проблемную реплику на уважительный и безопасный ответ в рамках правила. Не раскрывайте закрытые данные.|Мәселелі репликаны ережеге сай құрметті әрі қауіпсіз жауаппен ауыстырыңыз. Құпия деректерді ашпаңыз.|Replace the problematic message with a respectful, safe response that follows the rule. Do not disclose confidential data.
Перепишите проблемный ответ так, чтобы устранить указанное нарушение и помочь клиенту.|Көрсетілген бұзушылықты жойып, клиентке көмектесетіндей мәселелі жауапты қайта жазыңыз.|Rewrite the problematic response to remove the identified violation and help the customer.
Исправьте указанную ошибку, следуя действующему правилу критерия. Используйте только сведения из диалога.|Критерийдің қолданыстағы ережесіне сай көрсетілген қатені түзетіңіз. Тек диалогтағы мәліметтерді қолданыңыз.|Correct the identified issue using the current criterion rule. Use only information from the conversation.
Напишите новый ответ для этой ситуации с учётом ошибки и правила критерия.|Қате мен критерий ережесін ескеріп, осы жағдайға жаңа жауап жазыңыз.|Write a new response to this situation, considering the issue and the criterion rule.

Где посмотреть мой тариф?|Менің тарифімді қайдан көруге болады?|Where can I find my plan?
Здравствуйте! Откройте раздел «Кабинет».|Сәлеметсіз бе! «Кабинет» бөлімін ашыңыз.|Hello! Open your account dashboard.
Спасибо, нашёл.|Рақмет, таптым.|Thank you, I found it.
Выберите непустой файл размером до 5 МБ.|5 МБ дейінгі бос емес файлды таңдаңыз.|Choose a nonempty file up to 5 MB.
Не удалось прочитать текстовый файл. Сохраните его в UTF-8.|Мәтіндік файл оқылмады. Оны UTF-8 пішімінде сақтаңыз.|Unable to read the text file. Save it as UTF-8.
Документ слишком большой после распаковки. Сохраните его как TXT.|Құжат ашылғаннан кейін тым үлкен. Оны TXT ретінде сақтаңыз.|The uncompressed document is too large. Save it as TXT.
PDF защищён паролем. Сохраните копию без пароля.|PDF құпиясөзбен қорғалған. Құпиясөзсіз көшірмесін сақтаңыз.|This PDF is password protected. Save a copy without a password.
В PDF должно быть не больше 50 страниц.|PDF ішінде 50 беттен артық болмауы керек.|The PDF must contain no more than 50 pages.
В PDF нет текста. Вставьте расшифровку или выберите документ с текстом.|PDF ішінде мәтін жоқ. Транскрипцияны енгізіңіз немесе мәтіні бар құжатты таңдаңыз.|This PDF contains no text. Paste a transcript or choose a text-based document.
Поддерживаются файлы TXT, DOCX, PDF с текстом, JSON и изображения PNG, JPG, WebP.|TXT, DOCX, мәтіні бар PDF, JSON файлдары және PNG, JPG, WebP суреттері қолданылады.|Supported formats: TXT, DOCX, text-based PDF, JSON and PNG, JPG, WebP images.
Не удалось прочитать документ. Проверьте формат файла.|Құжат оқылмады. Файл пішімін тексеріңіз.|Unable to read the document. Check the file format.
В диалоге должно быть от 2 до 2000 реплик.|Диалогта 2-ден 2000-ға дейін реплика болуы керек.|A conversation must contain 2 to 2,000 messages.
Реплика|Реплика|Message
нужен объект с участником и текстом.|қатысушы мен мәтіні бар нысан қажет.|an object with a speaker and text is required.
участник должен быть client, operator, bot или system.|қатысушы client, operator, bot не system болуы керек.|the speaker must be client, operator, bot or system.
нужен непустой текст.|бос емес мәтін қажет.|nonempty text is required.
Текст одного диалога не должен превышать 100 000 символов.|Бір диалог мәтіні 100 000 таңбадан аспауы керек.|One conversation may contain up to 100,000 characters.
некорректное время. Используйте 00:15 или дату со временем и часовым поясом.|уақыт дұрыс емес. 00:15 не күні, уақыты және уақыт белдеуі бар пішімді қолданыңыз.|invalid timestamp. Use 00:15 or a date with time and timezone.
Нужны реплики клиента и оператора: client и operator.|Клиент пен оператор репликалары қажет: client және operator.|Both customer and agent messages are required: client and operator.
Не удалось прочитать JSON. Проверьте скобки, запятые и кодировку файла.|JSON оқылмады. Жақшаларды, үтірлерді және файл кодтауын тексеріңіз.|Unable to read JSON. Check brackets, commas and file encoding.
В JSON указан неуспешный ответ. Выберите файл с диалогами.|JSON ішінде сәтсіз жауап көрсетілген. Диалогтар бар файлды таңдаңыз.|The JSON contains an unsuccessful response. Choose a file with conversations.
Нужен JSON с одним диалогом или списком диалогов (не больше 5000).|Бір диалог не диалогтар тізімі бар JSON қажет (5000-нан аспауы керек).|Provide JSON with one conversation or a list of up to 5,000 conversations.
нужен объект с полем transcript или messages.|transcript не messages өрісі бар нысан қажет.|an object with a transcript or messages field is required.
Название должно быть строкой длиной от 1 до 120 символов.|Атауы 1-ден 120-ға дейін таңбадан тұруы керек.|The title must be text between 1 and 120 characters.
Язык должен быть RU, KZ или EN.|Тіл RU, KZ не EN болуы керек.|Language must be RU, KZ or EN.
Канал должен быть agent chat или voice call.|Арна agent chat не voice call болуы керек.|Channel must be agent chat or voice call.
Передайте текст или список реплик диалога.|Диалог мәтінін не репликалар тізімін беріңіз.|Provide text or a list of conversation messages.
Укажите название диалога.|Диалог атауын көрсетіңіз.|Enter a conversation title.
Достигнут лимит: 5000 диалогов.|5000 диалог лимитіне жетті.|The limit of 5,000 conversations has been reached.
Не удалось сохранить изменения. Проверьте доступ к папке данных и свободное место.|Өзгерістер сақталмады. Деректер қалтасына қолжетімділікті және бос орынды тексеріңіз.|Unable to save changes. Check data folder permissions and free disk space.
Чек-лист уже изменён. Обновите страницу|Бағалау ережелері өзгертілген. Бетті жаңартыңыз|The evaluation rules have changed. Refresh the page
Дождитесь завершения оценки|Бағалау аяқталғанша күтіңіз|Wait for the evaluation to finish
Уже выполняется оценка. Дождитесь завершения|Бағалау орындалуда. Аяқталғанша күтіңіз|An evaluation is already in progress. Wait for it to finish
Сначала разрешите ожидающие апелляции|Алдымен күтіп тұрған апелляцияларды шешіңіз|Resolve pending appeals first
Сначала рассмотрите ожидающие апелляции|Алдымен күтіп тұрған апелляцияларды қараңыз|Review pending appeals first
Оценка изменилась или неактуальна; обновите диалог|Бағалау өзгерген не ескірген; диалогты жаңартыңыз|The evaluation has changed or is outdated; refresh the conversation
Критерий не найден|Критерий табылмады|Criterion not found
Поясните основание апелляции|Апелляция негіздемесін түсіндіріңіз|Explain the reason for the appeal
По критерию уже есть ожидающая апелляция|Бұл критерий бойынша күтіп тұрған апелляция бар|This criterion already has a pending appeal
Апелляция не найдена|Апелляция табылмады|Appeal not found
Апелляция уже рассмотрена или её оценка неактуальна|Апелляция қаралған немесе оның бағасы ескірген|The appeal is resolved or its evaluation is outdated
Укажите причину решения|Шешім себебін көрсетіңіз|Enter the reason for your decision
Диалог не найден|Диалог табылмады|Conversation not found
Название и правило не должны быть пустыми|Атауы мен ережесі бос болмауы керек|Title and rule cannot be empty
Для N/A нужно условие неприменимости|N/A үшін қолданылмау шарты қажет|An exclusion condition is required for N/A
Флаг должен иметь вес 0 и не допускает N/A|Белгінің салмағы 0 болуы керек және N/A қолданылмайды|A flag must have weight 0 and cannot allow N/A
Для бинарного критерия max_scale = 1|Екілік критерий үшін max_scale = 1|A binary criterion must have max_scale = 1
Укажите уникальные ступени шкалы|Шкаланың бірегей қадамдарын көрсетіңіз|Provide unique score levels
Шкала должна включать 0 и max_scale|Шкалада 0 және max_scale болуы керек|The scale must include 0 and max_scale
Недопустимая ступень шкалы|Шкала қадамы жарамсыз|Invalid score level
Ступени разрешены только для шкалы|Қадамдар тек шкала үшін рұқсат етіледі|Score levels are only allowed for scale criteria
ID критериев должны быть уникальны|Критерий ID-лері бірегей болуы керек|Criterion IDs must be unique

Проверяйте диалоги, находите причины снижения оценки и разбирайте апелляции.|Диалогтарды тексеріп, бағаның төмендеу себептерін анықтаңыз және апелляцияларды қараңыз.|Review conversations, understand score deductions and resolve appeals.
Прозрачные решения по спорным оценкам. Все обращения команды в одном месте.|Даулы бағалар бойынша ашық шешімдер. Команданың барлық өтініштері бір жерде.|Transparent decisions on disputed scores. All team appeals in one place.
Общая картина качества: охват проверок, распределение баллов и результаты по каналам.|Сапаның жалпы көрінісі: тексеру қамтуы, балдардың таралуы және арналар бойынша нәтижелер.|A clear view of quality: evaluation coverage, score distribution and channel performance.
Установление контакта|Байланыс орнату|Opening and greeting
Выявление потребности|Қажеттілікті анықтау|Identifying needs
Идентификация|Сәйкестендіру|Identity verification
Корректность и полнота консультации|Кеңестің дұрыстығы мен толықтығы|Accuracy and completeness
Эмпатия и клиентоориентированность|Эмпатия және клиентке бағдарлану|Empathy and customer focus
Управление диалогом и грамотность|Диалогты басқару және сауаттылық|Conversation management and clarity
Завершение|Аяқтау|Closing
Нужен непустой текст длиной до 100 000 символов.|100 000 таңбаға дейінгі бос емес мәтін қажет.|Enter conversation text up to 100,000 characters.
Строка|Жол|Line
время укажите как 00:15 или 01:02:15.|уақытты 00:15 немесе 01:02:15 түрінде көрсетіңіз.|use a timestamp such as 00:15 or 01:02:15.
начните реплику с «Клиент:» или «Оператор:».|репликаны «Клиент:» не «Оператор:» деп бастаңыз.|start each message with “Client:” or “Operator:”.
В одном диалоге должно быть не больше 2000 реплик.|Бір диалогта 2000 репликадан артық болмауы керек.|A conversation may contain up to 2,000 messages.
После имени участника нужен текст реплики.|Қатысушы атынан кейін реплика мәтіні қажет.|Add a message after the speaker label.
Нужны реплики клиента и оператора. Подпишите их «Клиент:» и «Оператор:».|Клиент пен оператор репликалары қажет. Оларды «Клиент:» және «Оператор:» деп белгілеңіз.|Both customer and agent messages are required. Label them “Client:” and “Operator:”.

Диалоги|Диалогтар|Conversations
Апелляции|Апелляциялар|Appeals
Аналитика|Аналитика|Analytics
Правила оценки|Бағалау ережелері|Evaluation rules
Журнал действий|Әрекеттер журналы|Activity log
Настройки|Баптаулар|Settings
Контроль качества|Сапаны бақылау|Quality assurance
Рабочее пространство|Жұмыс кеңістігі|Workspace
Язык интерфейса|Интерфейс тілі|Interface language
Главная навигация|Негізгі навигация|Main navigation
Разделы|Бөлімдер|Sections
К переписке|Хат алмасуға өту|Skip to transcript
Качество диалогов|Диалог сапасы|Conversation quality
Каждый диалог — возможность стать лучше. Проверяйте качество и помогайте команде расти.|Әр диалог — жақсаруға мүмкіндік. Сапаны бақылап, командаңыздың дамуына көмектесіңіз.|Every conversation is an opportunity to improve. Review quality and help your team grow.
Решения на основе диалогов|Диалогтарға негізделген шешімдер|Insights from every conversation
Руководитель|Басшы|Supervisor
Оператор|Оператор|Agent
Клиент|Клиент|Customer
Бот|Бот|Bot
Система|Жүйе|System
Роль|Рөл|Role
КК|СБ|QA
ОП|ОП|AG
КЛ|КЛ|CU
Включить тёмную тему|Қараңғы тақырыпты қосу|Switch to dark theme
Включить светлую тему|Ашық тақырыпты қосу|Switch to light theme
Светлая тема. Переключить на тёмную|Ашық тақырып. Қараңғыға ауысу|Light theme. Switch to dark
Тёмная тема. Переключить на светлую|Қараңғы тақырып. Ашыққа ауысу|Dark theme. Switch to light
Светлая|Ашық|Light
Тёмная|Қараңғы|Dark
Всего диалогов|Барлық диалогтар|Total conversations
Оценено ИИ|ЖИ бағалаған|AI evaluated
Средний балл|Орташа балл|Average score
ожидают решения|шешім күтуде|awaiting a decision
Загрузка данных|Деректер жүктелуде|Loading data
Все диалоги|Барлық диалогтар|All conversations
Загрузить диалог|Диалог қосу|Upload conversation
Проверить несколько|Бірнешеуін бағалау|Evaluate a batch
Список диалогов|Диалогтар тізімі|Conversation list
Закрыть список|Тізімді жабу|Close conversation list
Работа с диалогами|Диалогтармен жұмыс|Conversation workspace
Очередь диалогов|Диалогтар кезегі|Conversation queue
Поиск диалога…|Диалог іздеу…|Search conversations…
Поиск диалогов|Диалогтарды іздеу|Search conversations
Все языки|Барлық тілдер|All languages
Все каналы|Барлық арналар|All channels
Язык|Тіл|Language
Канал|Арна|Channel
Чаты|Чаттар|Chats
Звонки|Қоңыраулар|Calls
Чат|Чат|Chat
Звонок|Қоңырау|Call
Статус оценки ИИ|ЖИ бағалау күйі|AI evaluation status
Любой статус|Барлық күйлер|Any status
Нет оценки ИИ|ЖИ бағасы жоқ|Not evaluated
Есть оценка ИИ|ЖИ бағасы бар|Evaluated
Оценка устарела|Бағалау ескірген|Outdated evaluation
ИИ оценивает|ЖИ бағалауда|Evaluating
Апелляция на рассмотрении|Апелляция қаралуда|Appeal pending
Грубые ошибки|Өрескел қателер|Critical issues
По актуальным оценкам ИИ|Ағымдағы ЖИ бағалары бойынша|Based on current AI evaluations
ДИАЛОГ|ДИАЛОГ|CONVERSATION
Загрузка диалогов…|Диалогтар жүктелуде…|Loading conversations…
Загрузка диалога…|Диалог жүктелуде…|Loading conversation…
Загрузка…|Жүктелуде…|Loading…
Обновить данные|Деректерді жаңарту|Refresh data
Обновить|Жаңарту|Refresh
ПЕРЕПИСКА|ХАТ АЛМАСУ|TRANSCRIPT
Переписка|Хат алмасу|Transcript
Выберите диалог|Диалогты таңдаңыз|Select a conversation
Выберите диалог.|Диалогты таңдаңыз.|Select a conversation.
Скачать результат|Нәтижені жүктеу|Download result
ЗАПИСЬ ЗВОНКА|ҚОҢЫРАУ ЖАЗБАСЫ|CALL RECORDING
Запись звонка|Қоңырау жазбасы|Call recording
Нажмите на время в оценке, чтобы перейти к фрагменту.|Үзіндіге өту үшін бағалаудағы уақытты басыңыз.|Select a timestamp in the evaluation to jump to that moment.
Служебные сообщения|Қызметтік хабарламалар|System messages
Здесь появится переписка|Хат алмасу осында көрсетіледі|The transcript will appear here
Исходная переписка|Түпнұсқа хат алмасу|Original transcript
Оценка качества|Сапаны бағалау|Quality assessment
Причины снижения оценки|Балл төмендеуінің себептері|Score deductions
Все критерии|Барлық критерийлер|All criteria
Список апелляций|Апелляциялар тізімі|Appeal list
Показать|Көрсету|Show
Все апелляции|Барлық апелляциялар|All appeals
Ожидают решения|Шешім күтуде|Awaiting decision
Рассмотренные|Қаралған|Resolved
Аналитика качества|Сапа аналитикасы|Quality analytics
Подать апелляцию|Апелляция беру|Submit an appeal
Основание|Негіздеме|Reason for appeal
С чем вы не согласны?|Немен келіспейсіз?|What do you disagree with?
Отмена|Бас тарту|Cancel
Отправить апелляцию|Апелляция жіберу|Send appeal
Рассмотреть апелляцию|Апелляцияны қарау|Review appeal
Закрыть|Жабу|Close
Решение|Шешім|Decision
Удовлетворить|Қанағаттандыру|Approve
Отклонить|Қабылдамау|Reject
Новая оценка|Жаңа баға|Updated score
Обоснование решения|Шешім негіздемесі|Decision rationale
Почему принято это решение?|Бұл шешім неге қабылданды?|Why was this decision made?
Сохранить решение|Шешімді сақтау|Save decision
Выберите файл|Файлды таңдаңыз|Choose a file
Перетащите файл сюда|Файлды осында сүйреңіз|Drop your file here
или нажмите, чтобы выбрать на компьютере|немесе компьютерден таңдау үшін басыңыз|or click to browse your computer
JSON, TXT, DOCX, PDF · скриншоты и фото PNG, JPG, WEBP · до 5 МБ ·|JSON, TXT, DOCX, PDF · PNG, JPG, WEBP скриншоттары мен фотолары · 5 МБ дейін ·|JSON, TXT, DOCX, PDF · screenshots and photos in PNG, JPG, WEBP · up to 5 MB ·
Пример JSON|JSON үлгісі|JSON example
Изображение диалога для проверки распознанного текста|Танылған мәтінді тексеруге арналған диалог суреті|Conversation image to verify recognized text
Сверьте текст ниже с исходным изображением.|Төмендегі мәтінді түпнұсқа суретпен салыстырыңыз.|Compare the text below with the original image.
Проверьте распознанный текст|Танылған мәтінді тексеріңіз|Review the recognized text
Распознавание выполняется на ноутбуке. Исправьте ошибки, особенно казахские буквы, и добавьте «Клиент:» или «Оператор:» перед каждой репликой. Роли не назначаются автоматически.|Мәтін ноутбукта танылады. Қателерді, әсіресе қазақ әріптерін түзетіп, әр репликаның алдына «Клиент:» немесе «Оператор:» қосыңыз. Рөлдер автоматты түрде белгіленбейді.|Recognition runs on your laptop. Correct any errors, especially Kazakh letters, and add “Client:” or “Operator:” before each message. Speaker roles are not assigned automatically.
Диалог из файла|Файлдағы диалог|Conversation from file
Название|Атауы|Title
Например, консультация по тарифу|Мысалы, тариф бойынша кеңес|For example, a pricing consultation
Тип диалога|Диалог түрі|Conversation type
Русский|Орысша|Russian
Қазақша|Қазақша|Kazakh
Расшифровка звонка|Қоңырау транскрипциясы|Call transcript
Текст диалога|Диалог мәтіні|Conversation text
Выберите файл или вставьте текст. Каждую реплику начните с «Клиент:» или «Оператор:». Время необязательно: 00:15 Клиент: …|Файлды таңдаңыз немесе мәтінді қойыңыз. Әр репликаны «Клиент:» не «Оператор:» деп бастаңыз. Уақыт міндетті емес: 00:15 Клиент: …|Choose a file or paste text. Start each message with “Client:” or “Operator:”. Timestamps are optional: 00:15 Client: …
Я проверил текст и роли участников по изображению|Мәтін мен қатысушылардың рөлдерін суретпен салыстырып тексердім|I checked the text and speaker roles against the image
Оценку ИИ можно запустить после добавления.|Диалогты қосқаннан кейін ЖИ бағалауын бастауға болады.|You can run an AI evaluation after adding the conversation.
Добавить диалог|Диалогты қосу|Add conversation
Изменения применятся ко всем диалогам.|Өзгерістер барлық диалогтарға қолданылады.|Changes will apply to all conversations.
Добавить критерий|Критерий қосу|Add criterion
Сохранить изменения|Өзгерістерді сақтау|Save changes
Пароль нужен, если доступ ограничен.|Қолжетімділік шектеулі болса, құпиясөз қажет.|A password is required when access is restricted.
Пароль руководителя|Басшы құпиясөзі|Supervisor password
Введите пароль|Құпиясөзді енгізіңіз|Enter password
Группа диалогов|Диалогтар тобы|Conversation group
Загрузить диалоги|Диалогтарды жүктеу|Load conversations
Сохранить|Сақтау|Save
Количество диалогов|Диалогтар саны|Number of conversations
Будут проверены первые диалоги без оценки из текущего списка.|Ағымдағы тізімдегі бағаланбаған алғашқы диалогтар тексеріледі.|The first unevaluated conversations in the current list will be reviewed.
Запустить оценку|Бағалауды бастау|Start evaluation
Скачать журнал|Журналды жүктеу|Download log
Нет соединения с сервером. Попробуйте ещё раз.|Сервермен байланыс жоқ. Қайталап көріңіз.|Unable to connect to the server. Please try again.
Проверьте заполненные поля.|Толтырылған өрістерді тексеріңіз.|Please check the form fields.
Нет доступа. Проверьте роль и пароль в настройках.|Қолжетімділік жоқ. Баптаулардағы рөл мен құпиясөзді тексеріңіз.|Access denied. Check your role and password in Settings.
Лимит проверок исчерпан.|Тексеру лимиті таусылды.|The evaluation limit has been reached.
Действие временно недоступно. Попробуйте позже.|Әрекет уақытша қолжетімсіз. Кейінірек көріңіз.|This action is temporarily unavailable. Try again later.
Не удалось выполнить действие. Попробуйте позже.|Әрекетті орындау мүмкін болмады. Кейінірек көріңіз.|Unable to complete the action. Try again later.
Не удалось выполнить действие.|Әрекетті орындау мүмкін болмады.|Unable to complete the action.
Осталось проверок:|Қалған тексерулер:|Evaluations left:
Лимит проверок отключён|Тексеру лимиті өшірілген|Evaluation limit disabled
Не удалось загрузить диалоги. Нажмите «Обновить».|Диалогтар жүктелмеді. «Жаңарту» түймесін басыңыз.|Unable to load conversations. Select Refresh.
Нет соединения|Байланыс жоқ|Disconnected
Локальное демо · роли без входа|Жергілікті демо · кірусіз рөлдер|Local demo · roles without sign-in
Доступ QA защищён токеном|Сапаны бақылау қолжетімділігі токенмен қорғалған|QA access is token protected
% от всех диалогов|% барлық диалогтан|% of all conversations
По выбранным условиям грубые ошибки не найдены.|Таңдалған шарттар бойынша өрескел қателер табылмады.|No critical issues match these filters.
Диалоги не найдены|Диалогтар табылмады|No conversations found
Не удалось открыть диалог. Выберите его ещё раз.|Диалог ашылмады. Оны қайта таңдаңыз.|Unable to open the conversation. Select it again.
По выбранным условиям диалогов нет.|Таңдалған шарттарға сай диалогтар жоқ.|No conversations match these filters.
Нет диалогов. Нажмите «Загрузить диалог».|Диалогтар жоқ. «Диалог қосу» түймесін басыңыз.|No conversations yet. Select Upload conversation.
ВРЕМЯ UTC|UTC УАҚЫТЫ|UTC TIME
Оценка ИИ с правками руководителя|Басшы түзеткен ЖИ бағасы|AI score with supervisor adjustments
Оценка ИИ|ЖИ бағасы|AI evaluation
Сначала рассмотрите апелляции.|Алдымен апелляцияларды қараңыз.|Review the pending appeals first.
Нет применимых критериев с баллами.|Балл қойылатын қолданбалы критерийлер жоқ.|No applicable scored criteria.
Оценка недоступна. Обратитесь к администратору.|Бағалау қолжетімсіз. Әкімшіге хабарласыңыз.|Evaluation is unavailable. Contact your administrator.
Проверьте обоснования и цитаты.|Негіздемелер мен дәйексөздерді тексеріңіз.|Review the rationale and supporting quotes.
Эту оценку нужно обновить.|Бұл бағалауды жаңарту қажет.|This evaluation needs to be refreshed.
из 100 баллов|100 балдан|out of 100
Итоговая оценка|Қорытынды баға|Final score
Предыдущая оценка|Алдыңғы баға|Previous score
Готов к проверке|Тексеруге дайын|Ready for review
голосовой звонок|дауыстық қоңырау|voice call
чат с оператором|оператормен чат|agent chat
Не учитывается:|Есепке алынбайды:|Excluded:
Оценка выполняется…|Бағалау орындалуда…|Evaluation in progress…
Оценить повторно|Қайта бағалау|Evaluate again
Оценить диалог|Диалогты бағалау|Evaluate conversation
Без баллов|Баллсыз|Unscored
Можно не учитывать|Есепке алмауға болады|May be excluded
Всегда применим|Әрқашан қолданылады|Always applicable
Не применяется|Қолданылмайды|Not applicable
Да / Нет|Иә / Жоқ|Yes / No
Да|Иә|Yes
Нет|Жоқ|No
Не влияет на итог|Қорытындыға әсер етпейді|Does not affect score
Вклад в итог:|Жалпы балдағы үлесі:|Score contribution:
Не учитывается|Есепке алынбайды|Excluded
Баллы:|Балдар:|Points:
Отметка о нарушении|Бұзушылық белгісі|Violation flag
Решение руководителя:|Басшы шешімі:|Supervisor decision:
Перейти к реплике|Репликаға өту|Go to message
и записи|және жазбаға|and recording
Предыдущее обоснование|Алдыңғы негіздеме|Previous rationale
Апелляция ожидает решения|Апелляция шешім күтуде|Appeal awaiting decision
Оспорить оценку|Бағаға шағымдану|Dispute score
Нажмите кнопку воспроизведения в записи.|Жазбадағы ойнату түймесін басыңыз.|Press play in the recording to start playback.
Проверяем диалог…|Диалог тексерілуде…|Evaluating conversation…
Оценка:|Баға:|Score:
Тип|Түрі|Type
Баллы|Балдар|Points
Вес|Салмақ|Weight
Макс. балл|Ең жоғары балл|Max score
Удалить критерий|Критерийді жою|Remove criterion
Допустимые баллы (через запятую)|Рұқсат етілген балдар (үтір арқылы)|Allowed scores (comma separated)
Можно поставить только баллы из этого списка.|Осы тізімдегі балдарды ғана қоюға болады.|Only scores in this list can be assigned.
Правило и исключения|Ереже және ерекшеліктер|Rule and exceptions
Правило|Ереже|Rule
Когда не учитывать|Қашан есепке алмау керек|When to exclude
Сумма весов:|Салмақтар қосындысы:|Total weight:
Дождитесь завершения оценки.|Бағалау аяқталғанша күтіңіз.|Wait for the evaluation to finish.
Добавлен диалог|Диалог қосылды|Conversation added
Диалоги загружены|Диалогтар жүктелді|Conversations loaded
Правила обновлены|Ережелер жаңартылды|Rules updated
Начата оценка|Бағалау басталды|Evaluation started
Оценка завершена|Бағалау аяқталды|Evaluation completed
Ошибка оценки|Бағалау қатесі|Evaluation failed
Подана апелляция|Апелляция берілді|Appeal submitted
Принято решение по апелляции|Апелляция бойынша шешім қабылданды|Appeal resolved
Тестовая оценка перенесена в историю|Сынақ бағасы тарихқа көшірілді|Test evaluation archived
Балл:|Балл:|Score:
Журнал пока пуст|Журнал әзірге бос|No activity yet
Почему снижена оценка|Баға неге төмендетілді|Why the score was reduced
В предыдущей оценке|Алдыңғы бағалауда|In the previous evaluation
Снижение общего балла|Жалпы балдың төмендеуі|Total score deduction
Полный комментарий|Толық түсініктеме|Full comment
К фрагменту|Үзіндіге өту|Go to excerpt
Грубые ошибки в предыдущей оценке|Алдыңғы бағалаудағы өрескел қателер|Critical issues in the previous evaluation
Загрузка апелляций…|Апелляциялар жүктелуде…|Loading appeals…
Не удалось загрузить апелляции. Откройте раздел ещё раз.|Апелляциялар жүктелмеді. Бөлімді қайта ашыңыз.|Unable to load appeals. Open this section again.
Всего:|Барлығы:|Total:
Диалог|Диалог|Conversation
Критерий|Критерий|Criterion
Комментарий|Түсініктеме|Comment
Статус|Күйі|Status
Создана|Жасалған|Created
Действие|Әрекет|Action
Диалог недоступен|Диалог қолжетімсіз|Conversation unavailable
Рассмотреть|Қарау|Review
Открыть|Ашу|Open
Апелляций по выбранному условию нет.|Таңдалған шарт бойынша апелляциялар жоқ.|No appeals match this filter.
Ожидает решения|Шешім күтуде|Pending
Удовлетворена|Қанағаттандырылды|Approved
Отклонена|Қабылданбады|Rejected
Предыдущая версия|Алдыңғы нұсқа|Previous version
Группа|Топ|Group
Диалогов|Диалогтар|Conversations
С оценкой ИИ|ЖИ бағасы бар|AI evaluated
Оценка диалогов|Диалогтарды бағалау|Evaluation coverage
Оценки ИИ с учётом решений по апелляциям|Апелляция шешімдері ескерілген ЖИ бағалары|AI evaluations including appeal decisions
Без актуальной оценки:|Ағымдағы бағасы жоқ:|Without current evaluation:
Грубые нарушения в оценённых диалогах:|Бағаланған диалогтардағы өрескел бұзушылықтар:|Critical issues in evaluated conversations:
Показать диалоги с грубыми ошибками|Өрескел қателері бар диалогтарды көрсету|View conversations with critical issues
Распределение баллов|Балдардың таралуы|Score distribution
Только диалоги с рассчитанным баллом|Тек балл есептелген диалогтар|Conversations with a calculated score only
По языкам|Тілдер бойынша|By language
По каналам|Арналар бойынша|By channel
Средний балл по актуальным оценкам|Ағымдағы бағалар бойынша орташа балл|Average based on current evaluations
Размер файла должен быть не больше 5 МБ.|Файл көлемі 5 МБ-тан аспауы керек.|The file must be 5 MB or smaller.
Читаем документ…|Құжат оқылуда…|Reading document…
Распознаём текст на фото…|Фотодағы мәтін танылуда…|Recognizing text in the image…
В файле диалогов:|Файлдағы диалогтар:|Conversations in file:
Выберите нужный для добавления.|Қосу үшін қажеттісін таңдаңыз.|Choose the conversation to add.
Диалог загружен. Проверьте реплики перед добавлением.|Диалог жүктелді. Қоспас бұрын репликаларды тексеріңіз.|Conversation loaded. Review the messages before adding it.
Текст загружен. Проверьте реплики перед добавлением.|Мәтін жүктелді. Қоспас бұрын репликаларды тексеріңіз.|Text loaded. Review the messages before adding it.
Текст распознан. Проверьте его и укажите роли участников.|Мәтін танылды. Оны тексеріп, қатысушылардың рөлдерін белгілеңіз.|Text recognized. Review it and label each speaker.
Подтвердите, что проверили текст и роли участников.|Мәтін мен қатысушылардың рөлдерін тексергеніңізді растаңыз.|Confirm that you reviewed the text and speaker roles.
Добавляем…|Қосылуда…|Adding…
Диалог добавлен.|Диалог қосылды.|Conversation added.
Диалог сохранён, но список не обновился. Нажмите «Обновить».|Диалог сақталды, бірақ тізім жаңармады. «Жаңарту» түймесін басыңыз.|Conversation saved, but the list did not refresh. Select Refresh.
Дождитесь завершения проверки.|Тексеру аяқталғанша күтіңіз.|Wait for the current evaluation to finish.
Нет доступных проверок или диалогов без оценки.|Қолжетімді тексерулер не бағаланбаған диалогтар жоқ.|No evaluations or unevaluated conversations are available.
Можно проверить до|Тексеруге болатын диалог саны:|You can evaluate up to
Не удалось загрузить запись.|Жазбаны жүктеу мүмкін болмады.|Unable to load the recording.
Апелляция отправлена.|Апелляция жіберілді.|Appeal submitted.
Решение сохранено. Итог:|Шешім сақталды. Қорытынды:|Decision saved. Final score:
Новый критерий|Жаңа критерий|New criterion
Опишите правило оценки|Бағалау ережесін сипаттаңыз|Describe the evaluation rule
Правила сохранены. Нужно обновить оценок:|Ережелер сақталды. Жаңартылатын бағалар:|Rules saved. Evaluations to refresh:
Изменения сохранены. Обновлено оценок:|Өзгерістер сақталды. Жаңартылған бағалар:|Changes saved. Evaluations updated:
Настройки сохранены.|Баптаулар сақталды.|Settings saved.
Проверьте название группы|Топ атауын тексеріңіз|Check the group name
Загружено|Жүктелді|Loaded
Проверяем диалоги:|Диалогтар тексерілуде:|Evaluating conversations:
Проверено:|Тексерілді:|Evaluated:
Проверено|Тексерілді|Evaluated
Остальные диалоги не удалось проверить.|Қалған диалогтарды тексеру мүмкін болмады.|The remaining conversations could not be evaluated.
Распознавание фото доступно на macOS. Вставьте текст диалога вручную.|Фото тану macOS жүйесінде қолжетімді. Диалог мәтінін қолмен енгізіңіз.|Image recognition is available on macOS. Paste the conversation text manually.
Не удалось подготовить распознавание фото. Вставьте текст вручную.|Фото тануды дайындау мүмкін болмады. Мәтінді қолмен енгізіңіз.|Unable to prepare image recognition. Paste the text manually.
Для распознавания фото нужны инструменты разработчика macOS. Вставьте текст вручную.|Фото тану үшін macOS әзірлеуші құралдары қажет. Мәтінді қолмен енгізіңіз.|Image recognition requires macOS developer tools. Paste the text manually.
Уже распознаётся другое фото. Подождите и повторите загрузку.|Басқа фото танылуда. Күтіп, қайта жүктеңіз.|Another image is being recognized. Wait and try again.
Распознавание заняло слишком много времени. Выберите более чёткое фото или вставьте текст.|Тану тым ұзаққа созылды. Анығырақ фото таңдаңыз немесе мәтінді енгізіңіз.|Recognition took too long. Choose a clearer image or paste the text.
Не удалось распознать фото. Выберите другое изображение или вставьте текст.|Фотодағы мәтін танылмады. Басқа суретті таңдаңыз немесе мәтінді енгізіңіз.|Unable to recognize text. Choose another image or paste the text.
Не удалось прочитать изображение. Выберите PNG, JPG или WebP до 24 мегапикселей.|Сурет оқылмады. 24 мегапиксельге дейінгі PNG, JPG не WebP таңдаңыз.|Unable to read the image. Choose PNG, JPG or WebP up to 24 megapixels.
На изображении не найден текст. Загрузите чёткий скриншот переписки.|Суреттен мәтін табылмады. Хат алмасудың анық скриншотын жүктеңіз.|No text was found. Upload a clear screenshot of the conversation.
Текст слишком длинный: максимум 100 000 символов.|Мәтін тым ұзын: ең көбі 100 000 таңба.|The text is too long: maximum 100,000 characters.
диалогов группы|топ диалогтары|conversations in group
диалогов|диалог|conversations
критериев|критерий|criteria
реплик|реплика|messages
чатов|чат|chats
звонков|қоңырау|calls
баллов|балл|points
из|/|of
Мои апелляции|Менің апелляцияларым|My appeals
На рассмотрении:|Қаралуда:|Under review:
Что требует внимания|Назар аударуды қажет етеді|Needs attention
Рекомендация|Ұсыныс|Recommendation
Можно оспорить любой критерий. Выберите нужный и поясните причину.|Кез келген критерийге шағымдануға болады. Қажеттісін таңдап, себебін түсіндіріңіз.|You can appeal any criterion. Select one and explain why.
Отправляем…|Жіберілуде…|Sending…
Апелляция уже отправляется. Дождитесь результата.|Апелляция жіберіліп жатыр. Нәтижесін күтіңіз.|This appeal is being sent. Please wait for the result.
Оценка изменилась. Закройте форму и обновите диалог.|Баға өзгерді. Нысанды жауып, диалогты жаңартыңыз.|The evaluation has changed. Close the form and refresh the conversation.
К оценке|Бағаға өту|View assessment
Практика навыка|Дағдыны жаттықтыру|Skill practice
Полный комментарий|Толық түсініктеме|Full explanation
Помощник руководителя|Басшы көмекшісі|Manager assistant
AI-помощник|AI-көмекші|AI assistant
Открыть AI-помощника|AI-көмекшіні ашу|Open AI assistant
Закрыть AI-помощника|AI-көмекшіні жабу|Close AI assistant
Запросы без ограничений|Сұраулар шектеусіз|Unlimited requests
Нужен ручной разбор|Қолмен талдау қажет|Manual review needed
AI не смог надёжно оценить диалог. Проверьте исходную переписку.|AI диалогты сенімді бағалай алмады. Бастапқы хат алмасуды тексеріңіз.|AI could not assess this conversation reliably. Review the original conversation.
Оценка не выставлена|Баға қойылмаған|No score assigned
Повторить проверку|Қайта тексеру|Retry evaluation
Другие подтверждающие реплики|Қосымша дәлел келтірілген репликалар|Additional supporting messages
Находит диалоги и объясняет результаты|Диалогтарды тауып, нәтижелерді түсіндіреді|Find conversations and understand results
Закрыть помощника|Көмекшіні жабу|Close assistant
Помощник не меняет оценки, правила или решения по апелляциям.|Көмекші бағаларды, ережелерді және апелляция шешімдерін өзгертпейді.|The assistant does not change scores, rules or appeal decisions.
С чего начнём?|Неден бастаймыз?|Where shall we start?
Задайте вопрос о качестве или найдите нужные диалоги.|Сапа туралы сұраңыз немесе қажетті диалогтарды табыңыз.|Ask about quality or find the conversations you need.
Найди диалоги с грубыми ошибками|Өрескел қателері бар диалогтарды тап|Find conversations with gross violations
Покажи диалоги на казахском без оценки|Бағаланбаған қазақша диалогтарды көрсет|Show unevaluated conversations in Kazakh
Что улучшить в работе команды?|Топ жұмысында нені жақсартуға болады?|What should the team improve?
Готовим ответ…|Жауап дайындалуда…|Preparing an answer…
Ваш вопрос|Сұрағыңыз|Your question
Например, какие ошибки повторяются чаще?|Мысалы, қандай қателер жиі қайталанады?|For example, which issues recur most often?
Продолжить|Жалғастыру|Continue
Отправить|Жіберу|Send
Запрос отправляется по текущим настройкам защиты данных.|Сұрау деректерді қорғаудың ағымдағы баптауларымен жіберіледі.|The request uses the current data protection settings.
Это отдельный запрос к AI по текущим настройкам защиты.|Бұл ағымдағы қорғау баптауларымен AI-ға бөлек сұрау.|This is a separate AI request using the current protection settings.
Как рассчитана сводка|Жиынтық қалай есептелді|How the summary is calculated
DEV · синтетические данные|DEV · синтетикалық деректер|DEV · synthetic data
Какие ошибки повторяются чаще|Қай қателер жиі қайталанады|Most frequent issues
По финальным оценкам с учётом апелляций. N/A и отсутствующие оценки не считаются ошибками. Частичное выполнение учитывается как замечание.|Апелляцияларды ескеретін соңғы бағалар бойынша. N/A және жоқ бағалар қате болып саналмайды. Ішінара орындалу ескерту ретінде саналады.|Based on final assessments including appeals. N/A and missing assessments are not errors. Partial compliance counts as an issue.
 применимых оценок · | қолданылатын баға · | applicable assessments ·\u0020
Диалоги и доказательства (|Диалогтар мен дәлелдер (|Conversations and evidence (
В актуальных оценках этой выборки замечаний не найдено.|Осы іріктеменің өзекті бағаларында ескертулер табылмады.|No issues were found in the current assessments in this selection.
В этой выборке нет актуальных оценок. Сводка ошибок пока недоступна.|Бұл іріктемеде өзекті бағалар жоқ. Қателер жиынтығы әзірге қолжетімсіз.|This selection has no current assessments. An issue summary is not available yet.
AI не закончил ответ в пределах лимита. Ответ не применён; автоматический повтор не выполнялся.|AI берілген лимитте жауапты аяқтамады. Жауап қолданылмады; автоматты қайталау жасалмады.|AI did not finish within the output limit. The response was not applied; no automatic retry was made.
AI отказался обрабатывать этот запрос. Фильтры и оценки не изменены.|AI бұл сұрауды өңдеуден бас тартты. Сүзгілер мен бағалар өзгерген жоқ.|AI declined this request. Filters and assessments were not changed.
AI вернул некорректную команду поиска. Фильтры и оценки не изменены; автоматический повтор не выполнялся.|AI қате іздеу пәрменін қайтарды. Сүзгілер мен бағалар өзгерген жоқ; автоматты қайталау жасалмады.|AI returned an invalid search command. Filters and assessments were not changed; no automatic retry was made.
AI-провайдер отклонил формат запроса. Требуется исправление приложения; менять формулировку вопроса не нужно.|AI провайдері сұрау пішімін қабылдамады. Қолданбаны түзету қажет; сұрақты өзгертудің қажеті жоқ.|The AI provider rejected the request format. The application needs a fix; you do not need to rephrase your question.
Не удалось получить ответ AI-провайдера. Проверьте подключение и доступность API. Автоматический повтор не выполнялся.|AI провайдерінен жауап алынбады. Қосылым мен API қолжетімділігін тексеріңіз. Автоматты қайталау жасалмады.|No response was received from the AI provider. Check the connection and API availability. No automatic retry was made.
Не удалось обработать ответ помощника. Фильтры и оценки не изменены; автоматический повтор не выполнялся.|Көмекшінің жауабы өңделмеді. Сүзгілер мен бағалар өзгерген жоқ; автоматты қайталау жасалмады.|The assistant response could not be processed. Filters and assessments were not changed; no automatic retry was made.
Перед отправкой вы увидите, какие данные получит AI.|Жібермес бұрын AI алатын деректерді көресіз.|You will see what data AI receives before sending.
Что получит AI|AI не алады|What AI will receive
Проверьте подготовленный запрос перед отправкой.|Жібермес бұрын дайындалған сұрауды тексеріңіз.|Review the prepared request before sending.
Система скрывает найденные персональные данные. Автоматическая проверка может пропустить сведения; подготовленное содержимое передаётся внешнему AI-провайдеру.|Жүйе табылған жеке деректерді жасырады. Автоматты тексеру кейбір мәліметті өткізіп алуы мүмкін; дайындалған мазмұн сыртқы AI провайдеріне жіберіледі.|The system hides detected personal data. Automatic checks may miss information; the prepared content is sent to an external AI provider.
Дополнительно скрыть|Қосымша жасыру|Hide additional text
Каждый фрагмент с новой строки|Әр үзіндіні жаңа жолға жазыңыз|One exact snippet per line
Укажите точные фрагменты, которые нужно скрыть. Исходные диалоги останутся без изменений.|Жасырылатын нақты үзінділерді енгізіңіз. Бастапқы диалогтар өзгермейді.|Enter the exact snippets to hide. Original conversations remain unchanged.
Обновить предпросмотр|Алдын ала қарауды жаңарту|Refresh preview
Подтвердить и отправить|Растау және жіберу|Confirm and send
Содержание диалога|Диалог мазмұны|Conversation content
Оценка|Бағалау|Assessment
Фильтры|Сүзгілер|Filters
Активные фильтры|Белсенді сүзгілер|Active filters
Данные и AI|Деректер және AI|Data and AI
Источник диалогов и служебные настройки|Диалогтар көзі және қызметтік баптаулар|Conversation source and advanced settings
Группа определяет набор диалогов от организаторов. DEV — тестовый набор.|Топ ұйымдастырушылардан алынатын диалогтар жиынын анықтайды. DEV — тестілік жиын.|The group selects the organizers’ conversation dataset. DEV is a test dataset.
Обновить из источника|Дереккөзден жаңарту|Refresh from source
Скрывать персональные данные перед отправкой AI|AI-ға жібермес бұрын жеке деректерді жасыру|Hide personal data before sending to AI
Запретить внешнюю AI-обработку|Сыртқы AI өңдеуіне тыйым салу|Block external AI processing
Просмотр, фильтры и ручные решения продолжат работать. Проверки и AI-помощник будут недоступны.|Қарау, сүзгілер және қолмен шешім қабылдау жұмысын жалғастырады. Тексерулер мен AI көмекшісі қолжетімсіз болады.|Viewing, filters and manual decisions remain available. AI checks and the assistant will be unavailable.
Локальное демо: переключение ролей не заменяет полноценную авторизацию.|Жергілікті демо: рөлдерді ауыстыру толық авторизацияны алмастырмайды.|Local demo: switching roles does not replace full authentication.
Доступ руководителя защищён токеном.|Басшының қолжетімділігі токенмен қорғалған.|Manager access is protected by a token.
Внешняя AI-обработка запрещена в настройках.|Баптауларда сыртқы AI өңдеуіне тыйым салынған.|External AI processing is blocked in settings.
Внешняя AI-обработка запрещена|Сыртқы AI өңдеуіне тыйым салынған|External AI processing is blocked
Завершите открытый предпросмотр.|Ашық алдын ала қарауды аяқтаңыз.|Finish the open preview first.
Подготавливаем запрос на ноутбуке…|Сұрау ноутбукте дайындалуда…|Preparing the request on this laptop…
Фрагменты изменены. Обновите предпросмотр перед отправкой.|Үзінділер өзгерді. Жібермес бұрын алдын ала қарауды жаңартыңыз.|Snippets changed. Refresh the preview before sending.
Внешний запрос не нужен: доступен сохранённый результат.|Сыртқы сұрау қажет емес: сақталған нәтиже бар.|No external request is needed: a saved result is available.
Предпросмотр готов. Данные ещё не отправлены AI.|Алдын ала қарау дайын. Деректер AI-ға әлі жіберілген жоқ.|Preview ready. Data has not yet been sent to AI.
Маскирование включено|Жасыру қосылған|Masking is on
Маскирование выключено|Жасыру өшірілген|Masking is off
Полный запрос, включая инструкции и формат ответа|Нұсқаулар мен жауап пішімін қамтитын толық сұрау|Full request, including instructions and response format
Инструкции для AI|AI-ға арналған нұсқаулар|Instructions for AI
Содержимое запроса|Сұрау мазмұны|Request content
Контекст ответа|Жауап контексті|Response context
Новый запрос не расходуется.|Жаңа сұрау жұмсалмайды.|No new request is used.
Запросов к внешнему AI:|Сыртқы AI сұраулары:|External AI requests:
Предпросмотр устарел. Обновите его перед отправкой.|Алдын ала қарау ескірді. Жібермес бұрын жаңартыңыз.|The preview has expired. Refresh it before sending.
Балл ниже|Балл төмен|Score below
Балл выше|Балл жоғары|Score above
Результат критерия|Критерий нәтижесі|Criterion result
Проблема|Мәселе|Issue
Сортировка|Сұрыптау|Sort
Не выполнен|Орындалмаған|Not met
Выполнен|Орындалған|Met
Нет представления оператора|Оператор өзін таныстырмаған|Operator did not introduce themselves
Балл по возрастанию|Балл өсу ретімен|Score ascending
Балл по убыванию|Балл кему ретімен|Score descending
Сбросить фильтр|Сүзгіні тазалау|Clear filter
Сбросить все|Барлығын тазалау|Clear all
Осталось запросов:|Қалған сұраулар:|Requests remaining:
Оценено:|Бағаланды:|Evaluated:
Синтетический DEV-набор: результаты не являются показателями компании.|Синтетикалық DEV деректер жиыны: нәтижелер компания көрсеткіштері емес.|Synthetic DEV dataset: results do not represent company performance.
Результаты относятся только к загруженной выборке.|Нәтижелер тек жүктелген іріктемеге қатысты.|Results apply only to the loaded sample.
Могу предложить до трёх действий по актуальным оценкам.|Өзекті бағалар бойынша үшке дейін әрекет ұсына аламын.|I can suggest up to three actions based on current evaluations.
Подготовить рекомендации|Ұсыныстар дайындау|Prepare recommendations
Это отдельный запрос. Сначала откроется предпросмотр.|Бұл бөлек сұрау. Алдымен алдын ала қарау ашылады.|This is a separate request. A preview will open first.
Выборка:|Іріктеме:|Sample:
наблюдений:|байқаулар:|observations:
Гипотеза:|Болжам:|Hypothesis:
Недостаточно актуальных оценок для рекомендаций.|Ұсыныстар үшін өзекті бағалар жеткіліксіз.|There are not enough current evaluations for recommendations.
Найдено диалогов:|Табылған диалогтар:|Conversations found:
Показать в списке|Тізімде көрсету|Show in list
Исходная оценка AI:|Бастапқы AI бағасы:|Original AI score:
Все найденные диалоги доступны в списке.|Барлық табылған диалогтар тізімде қолжетімді.|All matching conversations are available in the list.
На что обратить внимание?|Неге назар аудару керек?|What needs attention?
Поиск отсутствия представления использует только явно сохранённые обоснования. Неоднозначные обоснования не включены; переоценка не выполнялась.|Өзін таныстырмауды іздеу тек сақталған нақты негіздемелерді пайдаланады. Екіұшты негіздемелер енгізілмеген; қайта бағалау жасалмады.|Missing-introduction search uses only explicit saved reasons. Ambiguous reasons are excluded; conversations were not re-evaluated.
Внешняя AI-обработка запрещена. Локальная модель не настроена; автоматический анализ недоступен. Просмотр и ручная работа доступны.|Сыртқы AI өңдеуіне тыйым салынған. Жергілікті модель бапталмаған; автоматты талдау қолжетімсіз. Қарау және қолмен жұмыс істеу қолжетімді.|External AI processing is blocked. No local model is configured; automated analysis is unavailable. Viewing and manual work remain available.
Ключ AI не настроен на сервере.|Серверде AI кілті бапталмаған.|No AI key is configured on the server.
Недостаточно доступных AI-запросов для этой операции.|Бұл әрекетке қолжетімді AI сұраулары жеткіліксіз.|There are not enough available AI requests for this operation.
Лимит AI-помощника исчерпан.|AI көмекшісінің лимиті таусылды.|The AI assistant limit has been reached.
Укажите до 40 фрагментов для скрытия, каждый от 1 до 200 символов.|Әрқайсысы 1–200 таңбадан тұратын 40-қа дейін жасырылатын үзіндіні енгізіңіз.|Enter up to 40 snippets to hide, each between 1 and 200 characters.
Выберите диалог для оценки.|Бағалау үшін диалог таңдаңыз.|Select a conversation to evaluate.
Сначала рассмотрите ожидающие апелляции.|Алдымен күтіп тұрған апелляцияларды қараңыз.|Review the pending appeals first.
Выберите упражнение и напишите ответ.|Жаттығуды таңдап, жауап жазыңыз.|Select an exercise and write an answer.
Напишите запрос помощнику.|Көмекшіге сұрау жазыңыз.|Write a request for the assistant.
Недостаточно подтверждённых данных для рекомендаций. Сначала просмотрите охват и результаты оценок.|Ұсыныстар үшін расталған деректер жеткіліксіз. Алдымен қамту мен бағалау нәтижелерін қараңыз.|There is not enough verified data for recommendations. Review coverage and evaluation results first.
Сначала откройте «Что получит AI» и подтвердите подготовленный запрос.|Алдымен «AI не алады» терезесін ашып, дайындалған сұрауды растаңыз.|Open “What AI will receive” and confirm the prepared request first.
Предпросмотр истёк. Подготовьте его заново.|Алдын ала қараудың мерзімі өтті. Қайта дайындаңыз.|The preview has expired. Prepare it again.
Предпросмотр подготовлен для другой роли или операции.|Алдын ала қарау басқа рөл не әрекет үшін дайындалған.|The preview was prepared for a different role or operation.
Данные или режим защиты изменились. Обновите предпросмотр перед отправкой.|Деректер не қорғау режимі өзгерді. Жібермес бұрын алдын ала қарауды жаңартыңыз.|Data or privacy settings changed. Refresh the preview before sending.
Содержимое запроса изменилось. Обновите предпросмотр.|Сұрау мазмұны өзгерді. Алдын ала қарауды жаңартыңыз.|The request content changed. Refresh the preview.
Исходные данные изменились. Подготовьте запрос заново.|Бастапқы деректер өзгерді. Сұрауды қайта дайындаңыз.|Source data changed. Prepare the request again.
Не удалось безопасно подготовить запрос. Отправка заблокирована; оригинал не отправлен.|Сұрауды қауіпсіз дайындау мүмкін болмады. Жіберу бұғатталды; түпнұсқа жіберілген жоқ.|The request could not be prepared safely. Sending was blocked; the original was not sent.
Некорректные условия поиска.|Іздеу шарттары қате.|The search conditions are invalid.
Это предпросмотр другой операции.|Бұл басқа әрекеттің алдын ала қарауы.|This preview belongs to a different operation.
Дождитесь ответа помощника.|Көмекшінің жауабын күтіңіз.|Wait for the assistant's answer.
Данные обновились во время ответа. Повторите запрос с новым предпросмотром.|Жауап кезінде деректер жаңарды. Жаңа алдын ала қараумен сұрауды қайталаңыз.|Data changed while the answer was being prepared. Retry with a new preview.
Помощник не смог подготовить проверяемый ответ. Запрос учтён; попробуйте уточнить формулировку.|Көмекші тексерілетін жауап дайындай алмады. Сұрау есептелді; тұжырымды нақтылап көріңіз.|The assistant could not produce a verifiable answer. The request was counted; try making your question more specific.
Подтверждён запрос к AI|AI сұрауы расталды|AI request confirmed
Изменены настройки защиты данных|Деректерді қорғау баптаулары өзгерді|Data privacy settings changed
Помощник подготовил ответ|Көмекші жауап дайындады|Assistant prepared an answer
Ошибка помощника|Көмекші қатесі|Assistant failed
В текущей выборке оценено:|Ағымдағы іріктемеде бағаланған:|Evaluated in the current selection:
Остальные замечания|Қалған ескертулер|Other findings

Наборы диалогов|Диалогтар жиындары|Conversation datasets
Загруженные|Жүктелген|Uploaded
DEV · тестовый набор для демонстрации|DEV · көрсетуге арналған сынақ жиыны|DEV · demonstration dataset
FBroker · контрольные чаты по основному чек-листу|FBroker · негізгі чек-лист бойынша бақылау чаттары|FBroker · control chats for the main checklist
SWAP сохранён для просмотра. Оценка будет доступна после отдельной инструкции организаторов.|SWAP қарау үшін сақталды. Бағалау ұйымдастырушылардың бөлек нұсқаулығынан кейін қолжетімді болады.|SWAP is available for viewing. Evaluation will be enabled after separate organizer instructions.
Общий обзор наборов хакатона. Это не показатели компании.|Хакатон жиындарының жалпы шолуы. Бұл компанияның көрсеткіштері емес.|Combined hackathon datasets. These are not company performance metrics.
Объединены разные наборы, включая тестовый DEV. Это не показатели компании.|Әртүрлі жиындар, соның ішінде DEV сынақ жиыны біріктірілген. Бұл компанияның көрсеткіштері емес.|Different datasets are combined, including the DEV test set. These are not company performance metrics.
По наборам|Жиындар бойынша|By dataset
Набор|Жиын|Dataset
Назначение|Мақсаты|Purpose
Тестовый набор|Сынақ жиыны|Test dataset
Контрольный набор|Бақылау жиыны|Control dataset
Ожидает инструкции|Нұсқаулықты күтуде|Awaiting instructions
`;
  const dictionary = Object.fromEntries(rows.trim().split('\n').filter(line=>line.trim()).map(line=>{const [ru,kk,en]=line.split('|');if(!ru||!kk||!en)throw new Error('Incomplete interface translation');return [ru,{ru,kk,en}];}));
  const escape = value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern = new RegExp('(?<![\\p{L}])('+Object.keys(dictionary).sort((a,b)=>b.length-a.length).map(escape).join('|')+')(?![\\p{L}])','gu');
  let current='ru';
  try { const saved=localStorage.getItem('freedom-cqa-language'); if(['ru','kk','en'].includes(saved))current=saved; } catch { /* Language selection remains available in private mode. */ }
  const t = value => { if(typeof value!=='string'||current==='ru')return value; return value.replace(pattern,key=>dictionary[key][current]); };
  const staticNodes=[];
  function capture(root) {
    for(const node of root.childNodes || []) {
      if(node.nodeType===3 && /[А-Яа-яЁёҚқ]/.test(node.nodeValue))staticNodes.push({node,value:node.nodeValue});
      else if(node.nodeType===1 && !['SCRIPT','STYLE'].includes(node.tagName)) {
        for(const attr of ['title','aria-label','placeholder','alt']) if(node.hasAttribute(attr))staticNodes.push({node,attr,value:node.getAttribute(attr)});
        capture(node);
      }
    }
  }
  function apply() {
    document.documentElement.lang=current;
    document.title='Freedom CQA · '+t('Качество диалогов');
    for(const record of staticNodes) {
      if(record.attr)record.node.setAttribute(record.attr,t(record.value));else record.node.nodeValue=t(record.value);
    }
    document.querySelectorAll('[data-locale]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.locale===current)));
  }
  window.CQA_I18N={t,locale:()=>({ru:'ru-RU',kk:'kk-KZ',en:'en-GB'}[current]),language:()=>current,
    initialize(){capture(document.body);apply();},
    set(language){if(!['ru','kk','en'].includes(language))return;current=language;try{localStorage.setItem('freedom-cqa-language',language);}catch{}apply();window.dispatchEvent(new Event('cqa-language-change'));},
    dictionary};
})();
