# تطبيق تحديث 3.7.4

فك محتويات هذه الحزمة فوق سورس Controller 3.7.3 واختر Replace/Overwrite ثم أعد Build.

هذه الحزمة تضبط Desktop Client ID الظاهر في لقطة Google Cloud داخل `src/config/google-oauth.json`.

Client Secret غير موجود داخل الحزمة. عند أول «ربط Google» سيطلبه الكونترولر داخل نافذة محلية مقنّعة، ثم يحفظه مشفراً بـ `safeStorage`.
