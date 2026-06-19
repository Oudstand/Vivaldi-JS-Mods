#!/bin/bash
set -euo pipefail

# ==========================================
# Vivaldi UI-Mods Patcher (stable + snapshot)
#
# Verwendung:
#   ./patch.sh            # patcht die stabile Version (Standard)
#   ./patch.sh stable     # patcht die stabile Version
#   ./patch.sh snapshot   # patcht die Snapshot-Version
#
# Hinweis CSS: Die CSS-Mods werden NICHT von diesem Skript injiziert.
# Sie werden direkt in Vivaldi unter
#   Einstellungen -> Darstellung -> "Benutzerdefinierte UI-Anpassungen"
# als Ordner ausgewaehlt; Vivaldi laedt die .css-Dateien dann selbst.
# Dieses Skript haelt den CSS-Ordner lediglich per git pull aktuell.
# ==========================================

# ==========================================
# KONFIGURATION (je nach Variante)
# ==========================================
VARIANT="${1:-stable}"

case "$VARIANT" in
    stable)
        VIVALDI_DIR="/opt/vivaldi/resources/vivaldi"
        LAUNCH_CMD="vivaldi"
        ;;
    snapshot)
        VIVALDI_DIR="/opt/vivaldi-snapshot/resources/vivaldi"
        LAUNCH_CMD="vivaldi-snapshot"
        ;;
    *)
        echo "FEHLER: Unbekannte Variante '$VARIANT'. Erlaubt: stable | snapshot"
        exit 1
        ;;
esac

HTML_FILE="$VIVALDI_DIR/window.html"

# Pfade automatisch ermitteln (dieses Skript liegt im "JS"-Ordner)
JS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Der CSS-Ordner liegt eine Ebene hoeher, daneben
CSS_DIR="$(dirname "$JS_DIR")/CSS"

# Besitzer des Repos ermitteln. Wichtig, falls das Skript als root laeuft
# (z. B. ueber den pacman-Hook): git pull MUSS als dieser Benutzer laufen,
# sonst landen root-owned Dateien im User-Repo und kuenftige Pulls scheitern.
REPO_OWNER="$(stat -c '%U' "$JS_DIR")"

echo "=== Vivaldi-Mods Patch: Variante '$VARIANT' ==="

# ==========================================
# 1. VIVALDI BEENDEN
# ==========================================
echo "Beende Vivaldi..."
pkill -x vivaldi-bin 2>/dev/null || true
pkill -x vivaldi 2>/dev/null || true
pkill -x vivaldi-snapshot 2>/dev/null || true
# Auf das tatsaechliche Prozessende warten (max. ~10s) statt blind zu schlafen
for _ in $(seq 1 20); do
    pgrep -x vivaldi-bin >/dev/null 2>&1 || break
    sleep 0.5
done

# ==========================================
# 2. GIT UPDATES (pull changes)
# ==========================================
echo "--- Git Updates ---"

# Fuehrt git pull als Repo-Besitzer aus. Fehler (z. B. offline) sind nicht
# fatal: der Patch soll auch ohne frische Updates durchlaufen.
pull_repo() {
    local dir="$1"
    if [ ! -d "$dir/.git" ]; then
        echo "ACHTUNG: Kein Git-Repo in $dir - ueberspringe Update."
        return 0
    fi
    echo "Update $dir ..."
    if [ "$(id -u)" -eq 0 ] && [ "$REPO_OWNER" != "root" ]; then
        sudo -u "$REPO_OWNER" git -C "$dir" pull --rebase --autostash || \
            echo "WARNUNG: git pull in $dir fehlgeschlagen - fahre mit vorhandenem Stand fort."
    else
        git -C "$dir" pull --rebase --autostash || \
            echo "WARNUNG: git pull in $dir fehlgeschlagen - fahre mit vorhandenem Stand fort."
    fi
}

pull_repo "$CSS_DIR"
pull_repo "$JS_DIR"

# ==========================================
# 3. WINDOW.HTML VORBEREITEN
# ==========================================
if [ ! -f "$HTML_FILE" ]; then
    echo "FEHLER: window.html nicht gefunden in $VIVALDI_DIR"
    exit 1
fi

echo "Vivaldi Installation gefunden."

# Backup-Logik: Wir stellen IMMER erst das Original wieder her,
# damit "custom.js" nicht mehrfach eingefuegt wird.
if [ -f "$HTML_FILE.bak" ]; then
    echo "Stelle Original-Backup wieder her..."
    sudo cp "$HTML_FILE.bak" "$HTML_FILE"
else
    echo "Erstelle erstes Backup..."
    sudo cp "$HTML_FILE" "$HTML_FILE.bak"
fi

# ==========================================
# 4. JS ZUSAMMENFUEHREN -> custom.js
# ==========================================
echo "Erstelle custom.js aus allen .js Dateien..."

# Jede Datei ist als IIFE gekapselt; ein zusaetzliches ';' zwischen den
# Dateien macht die Verkettung robust gegen fehlende Zeilenumbrueche/Semikola.
for f in "$JS_DIR"/*.js; do
    cat "$f"
    printf '\n;\n'
done | sudo tee "$VIVALDI_DIR/custom.js" > /dev/null

echo "custom.js wurde nach $VIVALDI_DIR kopiert."

# ==========================================
# 5. HTML PATCHEN
# ==========================================
echo "Passe window.html an..."
sudo sed -i 's|</body>|  <script src="custom.js"></script>\n</body>|' "$HTML_FILE"

# ==========================================
# 6. VIVALDI STARTEN
# ==========================================
if [ "$(id -u)" -ne 0 ]; then
    echo "Fertig! Starte Vivaldi..."
    nohup "$LAUNCH_CMD" >/dev/null 2>&1 &
else
    echo "Fertig! Skript laeuft als root (z. B. pacman-Hook); Vivaldi wird nicht gestartet."
    echo "Bitte Vivaldi normal als Benutzer starten, damit Profil und KWallet korrekt geladen werden."
fi
