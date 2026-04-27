param(
    [int]$Port = 8090
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = Join-Path $projectRoot "backend\src"
$binaryRoot = Join-Path $projectRoot "backend\bin"
$libraryRoot = Join-Path $projectRoot "backend\lib"
$javaFiles = Get-ChildItem -Path $sourceRoot -Recurse -Filter *.java | Select-Object -ExpandProperty FullName
$compileClassPath = @(
    (Join-Path $libraryRoot "jackson-annotations-2.17.2.jar"),
    (Join-Path $libraryRoot "jackson-core-2.17.2.jar"),
    (Join-Path $libraryRoot "jackson-databind-2.17.2.jar"),
    (Join-Path $libraryRoot "h2-2.2.224.jar")
) -join ";"

if (-not $javaFiles) {
    throw "No Java source files were found under $sourceRoot"
}

New-Item -ItemType Directory -Force $binaryRoot | Out-Null
New-Item -ItemType Directory -Force (Join-Path $projectRoot "data") | Out-Null

& javac -encoding UTF-8 -cp $compileClassPath -d $binaryRoot $javaFiles
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$classPath = "$binaryRoot;$compileClassPath"
& java "-Dstudyplanner.root=$projectRoot" "-Dstudyplanner.port=$Port" -cp $classPath com.studyplanner.StudyPlannerServer
