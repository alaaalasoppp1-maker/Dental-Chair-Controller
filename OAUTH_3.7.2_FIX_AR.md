# Controller 3.7.2 — إصلاح إكمال Google OAuth المحلي

## المشكلة
كان المتصفح يعرض «تم ربط Google بنجاح» بمجرد وصول Authorization Code إلى مستمع 127.0.0.1، قبل أن ينفذ Controller تبادل الرمز مع Google ويحفظ refresh token مشفراً بواسطة Electron safeStorage. لذلك كان من الممكن أن يرى المستخدم نجاحاً في المتصفح بينما يبقى البرنامج «Google غير مربوط على هذا الجهاز» إذا فشلت خطوة لاحقة.

كما كان redirect المحلي يستخدم مسار `/oauth2/callback`. تم تغييره إلى loopback root بصيغة `http://127.0.0.1:<random-port>` المطابقة لمسار Desktop/installed-app loopback.

## الإصلاح
- loopback redirect صار `http://127.0.0.1:<port>` بلا مسار إضافي.
- المتصفح لا يعرض النجاح إلا بعد نجاح token exchange + فحص البريد + وجود refresh token + تشفيره وكتابته محلياً.
- عند الفشل تظهر صفحة واضحة في المتصفح برمز الخطأ بدلاً من نجاح كاذب.
- يحتفظ Controller محلياً بآخر رمز خطأ OAuth للتشخيص، بدون تخزين أي Google token في Firestore.
- لا يوجد Client Secret ولا Firebase Functions.

## ماذا تفعل
ابنِ Controller 3.7.2 من هذا السورس وشغله، ثم نفذ «ربط Google» من جديد. لا تغيّر Desktop Client ID إذا كان الربط يصل فعلاً إلى صفحة موافقة Google.
