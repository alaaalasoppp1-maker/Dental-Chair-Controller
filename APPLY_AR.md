# تطبيق Controller 3.7.2 فوق 3.7.1

1. أغلق Controller بالكامل.
2. خذ نسخة احتياطية من مجلد Controller الحالي.
3. انسخ محتويات هذا ZIP فوق سورس Controller 3.7.1 واختر Replace/Overwrite.
4. هذا الـPatch لا يحتوي `src/config/google-oauth.json`، لذلك Desktop Client ID الحالي لن يتغير.
5. ابنِ Controller من جديد ثم شغله.
6. نفّذ «ربط Google» مرة أخرى.
7. هذه المرة صفحة المتصفح لن تقول نجاحاً إلا بعد حفظ refresh token المشفر فعلياً على الجهاز.
