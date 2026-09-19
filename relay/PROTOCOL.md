# Relay-Protokoll v1

Diese öffentliche Repo transportiert ausschließlich **verschlüsselte** Browser-Steuerbefehle.

## Dateien

- `relay/command.enc.json` — aktuelles verschlüsseltes Kommando oder leerer Platzhalter.
- `userscript/ondo-public-relay.user.js` — lokaler Opera/Tampermonkey-Relay-Empfänger.

## Sicherheitsmodell

1. Das Userscript erzeugt beim ersten Start lokal ein RSA-OAEP-Schlüsselpaar.
2. Der private Schlüssel bleibt ausschließlich im lokalen Tampermonkey/GM-Speicher.
3. Nur der öffentliche Schlüssel darf außerhalb des Geräts verwendet oder gespeichert werden.
4. Befehle werden mit einem zufälligen AES-256-GCM-Schlüssel verschlüsselt.
5. Der AES-Schlüssel wird mit RSA-OAEP/SHA-256 für den lokalen Empfänger verschlüsselt.
6. Die öffentliche Repo enthält niemals Klartext-Prompts, API-Schlüssel, Tokens oder private Schlüssel.
7. Das Userscript liest ausschließlich `main/relay/command.enc.json`.
8. Ein Kommando wird nur einmal ausgeführt und muss vor Ablauf seiner `expires_at`-Zeit liegen.
9. Ausführung bleibt auf `https://chat.mistral.ai` begrenzt.

Das private Repository `Ondo-Control/ondo-ai-lab` bleibt die verbindliche Projektquelle.