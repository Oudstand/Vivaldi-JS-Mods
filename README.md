# Vivaldi UI-Mods – Patch Setup

Diese Mods bestehen aus zwei Teilen:

- **JS-Mods** (dieser Ordner) werden zu einer einzigen `custom.js` zusammengeführt
  und über ein `<script>`-Tag in Vivaldis `window.html` eingebunden.
- **CSS-Mods** (Ordner `../CSS`) werden **nicht** vom Patch injiziert, sondern
  direkt in Vivaldi als Ordner ausgewählt (siehe [CSS-Mods](#css-mods-beide-plattformen)).

Das Repo wird unter Linux **und** Windows verwendet; es gibt für jede Plattform
einen eigenen Patch-Workflow.

`automate-bookmark-bar.js` ergänzt `CSS/automate-bookmark-bar.css`: Der Helfer
verhindert einen hängen gebliebenen Hover-Zustand beim Wechsel in eine Webseite.
Für diese Korrektur muss neben dem CSS auch der JS-Patch erneut angewendet werden.

`workspace-command-highlight.js` ergänzt `CSS/web-panels.css`: Workspace-Kurzbefehle
werden anhand des tatsächlich aktiven Workspaces im jeweiligen Fenster markiert.
Unterstützt werden „Zum Arbeitsbereich N wechseln“ und Befehlsketten mit diesen
Befehlen. Die Zuordnung folgt der Workspace-Reihenfolge, unabhängig von Namen,
Icons und Themes. Der Mod liest Vivaldis internen Workspace-Zustand; nach größeren
Vivaldi-Updates kann eine Anpassung erforderlich sein. Auch hierfür den JS-Patch
erneut anwenden. Der Schritt „Zum Thema wechseln“ kann anschließend aus den
Befehlsketten entfernt werden, wenn kein Theme-Wechsel mehr gewünscht ist.

Der Mod startet automatisch in jedem Browserfenster. Ohne passende Kurzbefehle
in der Seitenleiste werden keine Buttons markiert. Es gibt keine Timer und kein
Polling: Der Mod hört auf Vivaldis Workspace-Store und Änderungen an Befehlsketten.
Der DOM-Beobachter berücksichtigt nur Änderungen innerhalb der Seitenleiste sowie
deren Austausch; andere UI-Änderungen lösen keine Neuberechnung aus.
Die Befehlsketten-Zuordnung wird zwischengespeichert.

Für die beiden Workspace-Kurzbefehle stehen im benachbarten CSS-Checkout
`../CSS/icons/arbeit.svg` und `../CSS/icons/freizeit.svg` als eigene Symbole bereit.
Die SVGs nutzen `currentColor` und übernehmen damit die
Ribbon-Vordergrundfarbe. In Vivaldi diese Dateien als eigene Symbole für die
Kurzbefehle auswählen. Die aktive Markierung zeichnet CSS auf den Button.

`media-focus.js` pausiert den Tab, der gerade Medien abspielt, sobald ein anderer Tab
oder ein Webpanel hörbar startet (zum Beispiel Spotify → YouTube). Pausiert oder endet
das neue Medium oder wird sein Tab geschlossen, läuft der vorherige Tab weiter. Manuell
pausierte Quellen werden nicht neu gestartet. Das gilt innerhalb eines Browserfensters;
gemerkt wird genau eine unterbrochene Quelle (kein Stapel: A → B → C lässt A pausiert).

Auslöser ist Vivaldis Ereignis `audiostatechanged`. Es meldet nur Hörbarkeit, deshalb
fragt der Mod zusätzlich in der Seite nach, ob ein Player läuft: über die Media Session
und die `audio`/`video`-Elemente. Stille Stellen gelten so nicht als Stopp;
stummgeschaltete Tabs und Töne ohne Player, etwa Benachrichtigungen, unterbrechen nichts.

Pausiert und fortgesetzt wird wie mit einer Medientaste über die `play`/`pause`-Handler,
die die Seite bei ihrer Media Session anmeldet. Dafür setzt der Mod beim Laden jeder
Seite einen kleinen Hook auf `MediaSession.setActionHandler` (per `chrome.scripting` in
der Welt der Seite, unabhängig von deren CSP). Seiten ohne solche Handler werden direkt
über ihre hörbaren `audio`/`video`-Elemente pausiert. Fortgesetzt wird nur, was der Mod
selbst pausiert hat.

Spotify meldet keinen Wiedergabezustand (`mediaSession.playbackState` bleibt `none`) und
hält sein Audio-Element außerhalb des DOM. Eine hörbare Seite mit `pause`-Handler gilt
deshalb als spielend, solange sie nicht ausdrücklich `paused` meldet. Wird sie still,
wartet der Mod drei Sekunden, damit ein Titelwechsel nicht als Stopp gilt. Das ist eine
Faustregel: Eine längere stille Stelle kann wie eine Pause wirken, und wer Spotify selbst
pausiert und in diesen drei Sekunden ein Video startet, bekommt Spotify danach wieder.

Vivaldi bietet keine bessere Schnittstelle: `vivaldi.tabsPrivate.onMediaStateChanged`
speist nur das Lautsprecher-Symbol und unterscheidet Stille nicht von Pause; zum
Pausieren gibt es nichts. Chromiums `AudioFocusEnforcement` wirkt in Vivaldi nicht.

Unter **Einstellungen → Tabs → Tab-Audio stummschalten** die Option
**Gesamtes Audio wiedergeben** wählen, damit keine zusätzliche Priorisierung durch
Vivaldi eingreift. Zum Aktivieren den JS-Patch erneut anwenden.

Grenzen: In Seiten, die schon vor dem Mod offen waren, sieht der Hook erst die nächste
Anmeldung eines Handlers (Spotify meldet sie bei jeder Zustandsänderung neu an). Nicht
erreichbar sind Player ohne Media-Session-Handler, die nicht als `audio`/`video` im DOM
stehen (reines Web Audio, Shadow DOM). Webseiten können automatisches Fortsetzen ablehnen.

`dialog.js` öffnet Links und Suchen in einem Dialog über der aktuellen Seite: per
gehaltener mittlerer Maustaste, über das Kontextmenü oder per Kurzbefehl. Einstellungen
stehen als Konstanten am Anfang der Datei, zum Beispiel `ICON_CONFIG` und `CONTEXT_MENU_CONFIG`.

| Kurzbefehl | Wirkung |
|---|---|
| `Ctrl+Alt+.` oder `Ctrl+Shift+F` | Öffnet die markierte URL im Dialog, sucht anderen markierten Text oder öffnet ohne Auswahl die Standardsuchmaschine |
| `Esc` | Beendet Vollbild im Dialog oder schließt ihn |

Als URL gilt nur eine Auswahl, die genau aus einer URL besteht, auch ohne Schema
mit `www.`. Alles andere wird gesucht, also auch `siehe https://example.com`.
Der Kontextmenü-Eintrag zeigt entsprechend `Öffne "…"` oder `Suche nach "…"`.

Der Mod nutzt interne Vivaldi-Schnittstellen, nach größeren Vivaldi-Updates kann
also eine Anpassung nötig sein. Der wechselnde Menütitel hängt an
`vivaldi.contextMenu.onDocumentMenu`. Fehlt dieses Event, zeigt der Eintrag
`Öffne oder suche "…"`. Scheitert die Einrichtung des Kontextmenüs ganz, fehlen nur
dessen Einträge; Kurzbefehle und Dialoge funktionieren weiter. Der Fehler steht dann
in der Konsole der Vivaldi-Oberfläche.

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
    tests/                 Tests, werden nicht in custom.js übernommen
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

## Tests

```bash
node --test --test-concurrency=1 tests/*.test.cjs
```

`--test-concurrency=1` ist nötig, weil die `*-browser.test.cjs`-Tests jeweils ein
echtes Vivaldi headless starten und sich parallel gegenseitig stören können. Sie
verwenden ein temporäres Profil, nie das eigene. Eine installierte `custom.js`
wird dabei mitgeladen; die Tests laufen trotzdem gegen die Dateien im Repo.

Der Medien-Browsertest führt den Mod in einem echten Vivaldi-Fenster mit Tabs, einem
Webpanel und einer Spotify-ähnlichen Testseite aus. Die Medienelemente sind simuliert,
es werden keine Audiodateien abgespielt und keine Testtöne erzeugt:

```bash
node tests/media-focus-browser.test.cjs
```

`node tests/media-focus.test.cjs` prüft die A/B-Logik ohne Browser, einschließlich
verzögerter Befehle, Zeitüberschreitungen, Abfragefehlern, veralteter Audioereignisse
und Deaktivierung während laufender Abfragen.

---

## CSS-Mods (beide Plattformen)

Die CSS-Dateien werden **nicht** vom Patch in `window.html` eingebunden. Stattdessen
liest Vivaldi sie selbst aus einem ausgewählten Ordner:

1. Vivaldi → Einstellungen → **Darstellung** → **Benutzerdefinierte UI-Anpassungen**
2. Den `CSS/`-Ordner dieses Repos auswählen
3. Vivaldi neu starten

Die Patch-Skripte (`patch.sh` / `patch.bat`) halten den `CSS/`-Ordner lediglich
per `git pull` aktuell; das Anwenden übernimmt Vivaldi.
