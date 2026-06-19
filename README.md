# Vivaldi UI-Mods – Patch Setup

Diese Mods bestehen aus zwei Teilen:

- **JS-Mods** (dieser Ordner) werden zu einer einzigen `custom.js` zusammengeführt
  und über ein `<script>`-Tag in Vivaldis `window.html` eingebunden.
- **CSS-Mods** (Ordner `../CSS`) werden **nicht** vom Patch injiziert, sondern
  direkt in Vivaldi als Ordner ausgewählt (siehe [CSS-Mods](#css-mods-beide-plattformen)).

Das Repo wird unter Linux **und** Windows verwendet; es gibt für jede Plattform
einen eigenen Patch-Workflow.

## Ordnerstruktur

```
<root>/
  CSS/                     CSS-Mods (per Browser-Ordner geladen)
  JS/                      diese Dateien
    patch.sh               Linux-Patcher (stable + snapshot)
    vivaldi-mod.hook       pacman-Hook (Arch/CachyOS)
    patch.bat              Windows-Patcher
    vivaldi_auto_patch.vbs Windows-Wrapper (unsichtbar)
    Vivaldi Patch on Launch.xml  Aufgabenplanung-Export (Windows)
    README.md              diese Datei
```

---

## Linux (Arch / CachyOS)

### Manuell patchen

```bash
./patch.sh            # stabile Version (Standard)  -> /opt/vivaldi
./patch.sh stable     # stabile Version             -> /opt/vivaldi
./patch.sh snapshot   # Snapshot-Version            -> /opt/vivaldi-snapshot
```

Das Skript:

1. beendet laufende Vivaldi-Prozesse,
2. zieht Änderungen für `CSS/` und `JS/` per `git pull` (als Repo-Besitzer,
   auch wenn das Skript als root läuft – siehe Hinweis unten),
3. stellt das Original `window.html` aus `window.html.bak` wieder her
   (bzw. legt beim ersten Lauf das Backup an),
4. führt alle `*.js` zu `custom.js` zusammen und kopiert sie nach
   `…/resources/vivaldi/`,
5. fügt `<script src="custom.js"></script>` vor `</body>` in `window.html` ein,
6. startet Vivaldi (nur wenn als normaler Benutzer ausgeführt).

> **root-Hinweis:** Schreiben unter `/opt` erfordert root, daher nutzt das Skript
> `sudo` für die Dateioperationen. Der `git pull` läuft jedoch bewusst als
> Repo-Besitzer (`sudo -u`), damit keine root-eigenen Dateien im `~/Git`-Repo
> landen, die spätere Pulls blockieren würden.

### Automatisch beim Vivaldi-Update (pacman-Hook)

`vivaldi-mod.hook` re-patcht die **Snapshot**-Version automatisch nach jedem
Paket-Update, da Vivaldi-Updates `window.html` überschreiben.

Installation des Hooks:

```bash
sudo cp "$(pwd)/vivaldi-mod.hook" /etc/pacman.d/hooks/vivaldi-mod.hook
```

Der Hook ruft `patch.sh snapshot` als `PostTransaction`-Aktion auf. Da pacman
als root läuft, startet das Skript Vivaldi in diesem Fall **nicht** selbst –
einfach Vivaldi danach normal als Benutzer starten.

> Bei Änderungen am Pfad oder Inhalt von `vivaldi-mod.hook` muss die Kopie unter
> `/etc/pacman.d/hooks/` erneut aktualisiert werden.

---

## Windows

Unter Windows wird Vivaldi automatisch gepatcht, sobald es gestartet wird und
noch kein Backup (`window.bak.html`) existiert.

### Ordnerstruktur (Windows)

```
<root>\
  Application\ <Version>\ resources\vivaldi\window.html
  JS\
    patch.bat
    vivaldi_auto_patch.vbs
    README.md
```

### Dateien

- **`patch.bat`** – die eigentliche Patch-Logik:
  - beendet Vivaldi (`taskkill`)
  - zieht Änderungen (CSS + JS) per `git pull`
  - sichert `window.html` als `window.bak.html`
  - führt alle `*.js` zu `custom.js` zusammen und patcht `window.html`
  - startet Vivaldi neu

- **`vivaldi_auto_patch.vbs`** – Wrapper für `patch.bat`, läuft **unsichtbar**:
  - kein `window.bak.html` vorhanden → `patch.bat` wird gestartet
  - bereits gepatcht → kein erneuter Patch (optional Start von Vivaldi, per
    Konstante `AutoStartVivaldi` steuerbar)

### Aufgabenplanung

Eine geplante Aufgabe **„Vivaldi Patch on Launch"** ruft beim Vivaldi-Start
`vivaldi_auto_patch.vbs` auf:

- **Trigger**: Security-Event 4688 (Start von `vivaldi.exe`)
- **Aktion**: startet `vivaldi_auto_patch.vbs`
- **Einstellungen**:
  - „Mit höchsten Privilegien ausführen"
  - „Wenn die Aufgabe bereits ausgeführt wird → Keine neue Instanz starten"

### Wichtige Option in `vivaldi_auto_patch.vbs`

```vbscript
Const AutoStartVivaldi = False
```

- `False` (Standard): Vivaldi wird nur durch `patch.bat` neu gestartet, wenn ein
  Patch erforderlich ist.
- `True`: auch wenn bereits gepatcht, startet Vivaldi sofort beim Trigger.

### Ablauf

1. Du startest Vivaldi (Taskleiste, Startmenü etc.)
2. Die Aufgabe erkennt den Start und führt `vivaldi_auto_patch.vbs` aus
3. `vivaldi_auto_patch.vbs` prüft:
   - **Backup fehlt** → `patch.bat` patcht Vivaldi und startet ihn neu
   - **Backup vorhanden** → es passiert nichts
4. Ergebnis: Vivaldi läuft sauber gepatcht, immer nur in einer Instanz

### Aufgabenplanung Import/Export

**Exportieren**
1. Aufgabenplanung öffnen
2. Aufgabe auswählen → Rechtsklick → **Exportieren…**
3. XML-Datei speichern (z. B. `Vivaldi Patch on Launch.xml`)

**Importieren**
1. Auf Ziel-PC Aufgabenplanung öffnen
2. Rechtsklick auf „Aufgabenplanungsbibliothek" → **Importieren…**
3. XML-Datei auswählen
4. Pfade in der Aufgabe anpassen (z. B. zu `vivaldi_auto_patch.vbs`), falls nötig
5. Mit Admin-Rechten bestätigen

### Fehlerbehebung (Windows)

- **„vivaldi.exe konnte nicht gefunden werden"**
  → In der Aufgabe prüfen, dass der Trigger-Pfad zur `vivaldi.exe` korrekt ist.
  Typisch: `C:\Users\<Name>\AppData\Local\Vivaldi\Application\vivaldi.exe`

- **Mehrere Instanzen von Vivaldi öffnen sich**
  → in der Aufgabe „Keine neue Instanz starten" auswählen
  → `AutoStartVivaldi = False` verwenden

- **Kein Patch trotz Neustart**
  → prüfen, ob `window.bak.html` bereits existiert (dann patcht die BAT nicht mehr)

---

## CSS-Mods (beide Plattformen)

Die CSS-Dateien werden **nicht** vom Patch in `window.html` eingebunden. Stattdessen
liest Vivaldi sie selbst aus einem ausgewählten Ordner:

1. Vivaldi → Einstellungen → **Darstellung** → **Benutzerdefinierte UI-Anpassungen**
2. Den `CSS/`-Ordner dieses Repos auswählen
3. Vivaldi neu starten

Die Patch-Skripte (`patch.sh` / `patch.bat`) halten den `CSS/`-Ordner lediglich
per `git pull` aktuell; das Anwenden übernimmt Vivaldi.
