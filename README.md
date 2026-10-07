# VSCode Review

Extension VSCode : commenter le diff staged via la Comments API. Gouttière "+" sur le
diff staged → commentaire inline → écrit dans `.review.json` (racine repo, git-ignoré).

## Structure

- `package.json` — manifest extension (commands, menus comments/*)
- `src/extension.ts` — logique, compilée vers `out/`
- `tsconfig.json` — `types: ["vscode", "node"]` volontaire, sinon tsc remonte dans
  `../../node_modules/@types` (three, webgpu...) et casse sur l'absence de lib DOM

## Bootstrap

```
npm install
npm run compile
```

## Installer en local

Pas de F5 / Extension Development Host — VSCodium a un comportement instance-unique :
ouvrir ce dossier dans une 2e fenêtre refocus la fenêtre déjà ouverte au lieu d'en créer
une nouvelle. À la place :

1. `Ctrl+Shift+P` → **Developer: Install Extension from Location...**
2. Sélectionner ce dossier (celui avec `package.json`)
3. Tourne directement dans la fenêtre courante

## Boucle de modif

1. Éditer `src/extension.ts`
2. `npm run compile`
3. `Ctrl+Shift+P` → **Developer: Reload Window**

## Point non-évident

Identifier les deux côtés d'un diff ouvert depuis Source Control (groupe
"Staged Changes") : URI scheme `git`, query JSON avec un champ `ref`.
- côté staged (droite, nouveau contenu) : `ref === ""` (chaîne vide)
- côté HEAD (gauche, ancien contenu — nécessaire pour commenter une suppression) :
  `ref === "HEAD"`

Piège : `ref === "~"` ressemble à "staged" mais désigne autre chose (utilisé ailleurs,
dans le diff working-tree) — ne matche ni l'un ni l'autre de ces deux côtés.
Vérifié par instrumentation (log des URIs ouvertes dans un output channel), pas de doc
officielle fiable là-dessus.

## Format `.review.json`

```json
[
  {
    "id": "uuid",
    "file": "chemin/relatif/au/repo.js",
    "side": "staged",
    "startLine": 10,
    "endLine": 15,
    "text": "commentaire",
    "excerpt": "contenu des lignes commentées",
    "response": "comment Claude a traité le commentaire"
  }
]
```

Lignes 1-based, inclusives. `side` précise sur quelle version du fichier portent
`startLine`/`endLine` : `"staged"` (contenu après modif, cas général) ou `"head"`
(contenu avant modif — commentaire sur une suppression, lignes absentes du fichier
staged donc sans correspondance côté `"staged"`).

`response` (optionnel) : écrit directement dans le JSON par Claude après traitement
d'un commentaire, pas par l'extension elle-même. Affiché comme 2e message du thread
(auteur "Claude"), lecture seule — pas d'icône éditer/supprimer dessus (voir
`contextValue` ci-dessous). Le watcher sur `.review.json` rafraîchit l'affichage dès
que le fichier est modifié, donc apparaît sans action de l'utilisateur.

## Re-ancrage sur modif du fichier

`startLine`/`endLine` sont figées au moment du commentaire — si des lignes sont
ajoutées/retirées ailleurs dans le fichier entre la création du commentaire et la
réouverture du diff, elles deviennent fausses. Mitigé (`locateRange`) : si le texte en
`excerpt` ne correspond plus aux lignes stockées, recherche ce texte ailleurs dans le
document et réancre le commentaire dessus. Marche si le texte commenté a juste bougé ;
pas de solution si le texte lui-même a été modifié ou supprimé (retombe sur les lignes
stockées, best effort). Recherche par égalité exacte de texte — si le même extrait
apparaît plusieurs fois dans le fichier, prend la première occurrence.

## Limites actuelles

- Staged + HEAD du même diff uniquement (pas unstaged, pas commit arbitraire) —
  extensible plus tard en élargissant `sideOf`
- Un seul commentaire + une réponse par thread (pas de fil de discussion multi-tours)
- Suppression/édition via icônes sur le commentaire (pas de suppression de thread
  entier) — réservées au commentaire de l'utilisateur via `contextValue: "editable"`,
  absent sur la réponse de Claude (clé `when` du menu : `comment == editable`)
- `.review.json` est surveillé (`createFileSystemWatcher`) : toute modif externe
  (suppression manuelle, vidage par un futur skill) rafraîchit les diffs ouverts
