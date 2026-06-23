@echo off

:: end Vivaldi ::
taskkill /F /IM vivaldi.exe /T


:: pull changes from GitHub ::
echo.
echo.
cd ..\CSS
echo Pull CSS from GitHub
git pull --rebase --autostash
echo.
echo Pull JS from GitHub
cd ..\JS
git pull --rebase --autostash
echo.
echo.

setlocal enabledelayedexpansion

:: This is a list of your Vivaldi installations' Application folders (you can use the Vivaldi folder, too, but it takes longer to find the file):
set installPaths="%~dp0..\Application\"
:: Don't alter anything below this point ;)



set nrOfInstalls=0
set "SuccessfulPatched=Couldn't Patch :^("

for %%i in (%installPaths%) do (
	<NUL set /p=Searching for newest window.html in %%~dpi...
	set /a nrOfInstalls=nrOfInstalls+1

	set installPath=%%~dpi
	set latestVersionFolder=

	for /f "tokens=*" %%a in ('dir /a:-d /b /s "!installPath!"') do (
		if "%%~nxa"=="window.html" set latestVersionFolder=%%~dpa
	)

	if not defined latestVersionFolder (
		set cnt=any
		echo.
		echo Couldn't find it. :(
		echo Is !installPath! the correct Vivaldi Application folder?
		echo.
	) else (
		echo Found it.
		echo.

		if exist !latestVersionFolder!\window.bak.html (
			echo Backup is already in place.
		) else (
			echo Creating a backup of your original window.html file.
			copy /y "!latestVersionFolder!\window.html" "!latestVersionFolder!\window.bak.html"
		)
		echo.
	)
)

findstr /v custom.js "!latestVersionFolder!\window.html" > temp0.txt

setlocal disabledelayedexpansion

(
  FOR /F "tokens=*" %%A IN (temp0.txt) DO (
  	IF "%%A" EQU "</body>" (
      echo ^<script src="custom.js"^>^</script^>
    )
    ECHO %%A
  )
) >temp.txt


setlocal enabledelayedexpansion



type *.js > !latestVersionFolder!\custom.js
move /Y temp.txt "!latestVersionFolder!window.html"
del temp0.txt
echo.
echo Copied files^^!


set cnt=0
for %%A in (*.js) do set /a cnt+=1
set "SuccessfulPatched=Succesfully Patched"


echo.
echo.
echo All done^^! :)   !SuccessfulPatched! !cnt! .js files^^!
echo.
echo.

:: Start Vivaldi ::
echo Start Vivaldi^^!
cd ..
cd Application
start vivaldi.exe
:: timeout 5
exit
