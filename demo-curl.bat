@echo off
setlocal EnableDelayedExpansion
rem The API answers in UTF-8. Switch this window to UTF-8 so "type" shows the
rem campus label dot correctly instead of a stray Chinese character.
chcp 65001 >nul
echo Script version: windows-cmd-1
echo Leave the server window open. This file runs in Command Prompt, not Bash.
set BASE=http://localhost:8099

echo.
echo Press Enter for the next call...
pause >nul
echo.
echo === 1. GET one item: K184206 house keys ===
curl.exe -s "%BASE%/api/items/K184206"
echo.

echo.
echo Press Enter for the next call...
pause >nul
echo.
echo === 2. GET search: category=electronics and status=stored ===
curl.exe -s "%BASE%/api/items?category=electronics&status=stored"
echo.

echo.
echo Press Enter for the next call...
pause >nul
echo.
echo === 3. POST create. No code in the body. ===
> "%TEMP%\lostdesk-body.json" echo {"name":"Black cap","category":"clothing","place":"library","campus":"MC","status":"stored","foundOn":"2026-11-19","spot":"Bin B3","description":"No name inside"}
curl.exe -s -X POST "%BASE%/api/items" -H "Content-Type: application/json" --data-binary "@%TEMP%\lostdesk-body.json" > "%TEMP%\lostdesk-item.json"
type "%TEMP%\lostdesk-item.json"
echo.
set CODE=
for /f "usebackq delims=" %%L in ("%TEMP%\lostdesk-item.json") do set LINE=%%L
for /f "tokens=2 delims=:," %%A in ("!LINE!") do set CODE=%%~A
echo.
echo New reference: !CODE!
if "!CODE!"=="" (
  echo Could not read the new reference. Stop here.
  pause
  exit /b 1
)

echo.
echo Press Enter for the next call...
pause >nul
echo.
echo === 4. PUT update !CODE! ===
> "%TEMP%\lostdesk-update.json" echo {"status":"claimed","description":"Owner collected it at the desk"}
curl.exe -s -X PUT "%BASE%/api/items/!CODE!" -H "Content-Type: application/json" --data-binary "@%TEMP%\lostdesk-update.json"
echo.

echo.
echo Press Enter for the next call...
pause >nul
echo.
echo === 5. DELETE !CODE! ===
curl.exe -s -X DELETE "%BASE%/api/items/!CODE!"
echo.

echo.
echo Press Enter for the next call...
pause >nul
echo.
echo === 6. GET deleted code, then the seeded keys ===
curl.exe -s -o NUL -w "Deleted code HTTP %%{http_code}\n" "%BASE%/api/items/!CODE!"
echo.
curl.exe -s -o NUL -w "K184206 HTTP %%{http_code}\n" "%BASE%/api/items/K184206"
echo.

echo.
echo Press Enter for the next call...
pause >nul
echo.
echo === 7. GET analytics: MongoDB aggregation results ===
curl.exe -s "%BASE%/api/analytics"
echo.
echo Done.
pause
