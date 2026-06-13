#!/bin/bash

# ==========================================
# KONFIGURATION
# ==========================================

# Vivaldi Snapshot Installationspfad unter CachyOS/Arch
VIVALDI_DIR="/opt/vivaldi-snapshot/resources/vivaldi"
HTML_FILE="$VIVALDI_DIR/window.html"

# Pfade automatisch ermitteln
# Wir gehen davon aus, dass dieses Skript im "JS"-Ordner liegt
JS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Der CSS-Ordner liegt eine Ebene höher, daneben
CSS_DIR="$(dirname "$JS_DIR")/CSS"

# ==========================================
# 1. VIVALDI BEENDEN (taskkill equivalent)
# ==========================================
echo "Beende Vivaldi..."
# Beendet alle laufenden Vivaldi-Prozesse
pkill vivaldi-bin
sleep 2

# ==========================================
# 2. GIT UPDATES (pull changes)
# ==========================================
echo "--- GitHub Updates ---"

# CSS updaten (wenn der Ordner existiert)
if [ -d "$CSS_DIR" ]; then
    echo "Update CSS Ordner ($CSS_DIR)..."
    cd "$CSS_DIR" && git pull --rebase --autostash
else
    echo "ACHTUNG: CSS-Ordner nicht gefunden! Erwartet in: $CSS_DIR"
fi

# JS updaten
echo "Update JS Ordner ($JS_DIR)..."
cd "$JS_DIR" && git pull --rebase --autostash


# ==========================================
# 3. WINDOW.HTML VORBEREITEN
# ==========================================
if [ ! -f "$HTML_FILE" ]; then
    echo "FEHLER: window.html nicht gefunden in $VIVALDI_DIR"
    exit 1
fi

echo "Vivaldi Installation gefunden."

# Backup Logik: Wir stellen IMMER erst das Original wieder her,
# damit wir nicht "custom.js" doppelt und dreifach einfügen.
if [ -f "$HTML_FILE.bak" ]; then
    echo "Stelle Original-Backup wieder her..."
    sudo cp "$HTML_FILE.bak" "$HTML_FILE"
else
    echo "Erstelle erstes Backup..."
    sudo cp "$HTML_FILE" "$HTML_FILE.bak"
fi


# ==========================================
# 4. JS ZUSAMMENFÜHREN (type *.js > custom.js)
# ==========================================
echo "Erstelle custom.js aus allen .js Dateien..."

# 'cat' liest alle Dateien, 'sudo tee' schreibt sie mit Root-Rechten
cat "$JS_DIR"/*.js | sudo tee "$VIVALDI_DIR/custom.js" > /dev/null

echo "custom.js wurde nach $VIVALDI_DIR kopiert."


# ==========================================
# 5. HTML PATCHEN
# ==========================================
echo "Passe window.html an..."

# Wir suchen nach </body> und ersetzen es durch <script...></body>
# Das entspricht deiner Schleife in der Batch-Datei.
sudo sed -i 's|</body>|  <script src="custom.js"></script>\n</body>|' "$HTML_FILE"


# ==========================================
# 6. VIVALDI STARTEN
# ==========================================
echo "Fertig! Starte Vivaldi..."
# Startet Vivaldi im Hintergrund und entkoppelt es vom Terminal
if [ "$(id -u)" -ne 0 ]; then
    nohup vivaldi-snapshot >/dev/null 2>&1 &
else
    echo "Skript laeuft als root; Vivaldi wird nicht gestartet."
    echo "Bitte Vivaldi Snapshot normal als Benutzer starten, damit Profil und KWallet korrekt geladen werden."
fi
