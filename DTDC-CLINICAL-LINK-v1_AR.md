# DTDC Clinical Link v1

العقد يربط Dental Chain OS وChair Controller وتطبيق Doctor Assistant، مع إبقاء Chair Display قناة عرض مستقلة.

## الأدوار

- `display`: يستقبل أوامر العرض فقط.
- `doctor_assistant`: يستقبل سياق المريض والخطط ويرسل الجلسات والوسائط.
- البرنامج الرئيسي يرسل أوامره محلياً إلى `127.0.0.1:8765`.

كل عميل WebSocket جديد يرسل:

```json
{"type":"client_hello","role":"display|doctor_assistant","protocol":5}
```

ثم يرسل `display_ready` أو `assistant_ready` حسب دوره.

## سياق المريض

الرسالة `assistant_patient_context` تحتوي `patient` و`plans`. كل خطة تستخدم `planId` و`serviceId` ثابتين، و`target` و`priority` و`plannedSessions` و`stages`.

إنهاء جلسة لا ينهي الخطة. إنهاء الخطة يتم برسالة مستقلة `assistant_plan_closed` بعد تأكيد الطبيب.

## الرجوع من المساعد

- WebSocket: `assistant_session` و`assistant_plan_closed`.
- HTTP: `POST /assistant/session` و`POST /assistant/plan-close` و`POST /assistant/event` لكل إجراء سريري تفصيلي.
- وسيط ثنائي: `POST /assistant/media` بنوع `application/octet-stream`، مع رؤوس `X-DTDC-Patient-Id` و`X-DTDC-Plan-Id` و`X-DTDC-Session-Id` و`X-DTDC-File-Name` و`X-DTDC-Mime-Type` و`X-DTDC-Media-Kind`.
- إيقاف عرض صورة المساعد: `POST /assistant/display-stop`.
- السياق الحالي: `GET /assistant/context`.
- البرنامج الرئيسي وحده يقرأ الأحداث عبر `GET /clinical/events` من loopback.

تُحفظ جلسات وأحداث وصور المساعد داخل `09 - جلسات المساعد` في مجلد المريض. تبقى تفاصيل الحدث كاملة في ملفه، بينما تُعرض للطبيب كعبارة عربية مع الوقت والسياق.
