ТЕСТОВЫЙ КОМПЛЕКТ ЛОКАЛЬНОГО ДВИЖКА

Это не публичный установщик и не финальный релиз.

Состав:
- engine\INSTALL_ENGINE.cmd — установка локального движка двойным кликом;
- engine\UNINSTALL_ENGINE.cmd — удаление движка;
- engine\dist\media-engine-host.exe — Native Messaging Host;
- engine\tools\ffmpeg.exe;
- engine\tools\ffprobe.exe;
- engine\tools\deno.exe;
- extension\ — распакованное тестовое расширение Chrome.

Порядок ручной проверки:
1. Распакуйте ZIP полностью в отдельную папку.
2. Запустите engine\INSTALL_ENGINE.cmd двойным кликом.
3. Откройте chrome://extensions.
4. Включите «Режим разработчика».
5. Нажмите «Загрузить распакованное расширение» и выберите папку extension.
6. Откройте обычное видео YouTube и нажмите «Скачать».
7. Убедитесь, что показаны только реально доступные качества.

PR пока не мержить. После проверки можно удалить движок через
engine\UNINSTALL_ENGINE.cmd.
