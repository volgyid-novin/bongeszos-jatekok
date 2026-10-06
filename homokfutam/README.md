# HOMOKFUTAM

3D podverseny a böngészőben, a régi podracer játékok hangulatában. A rajt egy arénában van, utána a pálya kimegy a sziklatűk közé, átmegy egy kanyonon és egy természetes sziklaív alatt, a végén pedig visszaér a tribünök elé.

Egyedül öt bot ellen versenyzel. Haverokkal 2–6 ember játszhat egy szobában, a maradék podokat botok vezetik. Játékszerver nincs: a böngészők közvetlenül kapcsolódnak egymáshoz (WebRTC, Trystero/Nostr), ugyanúgy, mint a BLOCKSHOT-ban.

## Indítás

A projekt gyökérmappájából (`D:\izsi\lol`):

```bash
npm install
npm run dev
```

Utána nyisd meg: http://localhost:5173/homokfutam/ (a BLOCKSHOT marad a http://localhost:5173 címen).

## Játék a haverokkal

A legegyszerűbb az állandó online link: **https://volgyid-novin.github.io/bongeszos-jatekok/homokfutam/**. Nyisd meg, írd be a neved, nyomj **ÚJ SZOBA**-t, és küldd el a meghívó linket.

Ha a saját gépedről akarod futtatni: az oldalt **HTTPS-en** (vagy localhoston) kell megnyitni, különben a szoba nem tud kapcsolódni.

**A) Gyorsan, regisztráció nélkül (Cloudflare quick tunnel)**

```bash
npm run build
npm run preview
```

Egy másik terminálban:

```bash
npx cloudflared tunnel --url http://localhost:4173
```

Nyisd meg a kiírt `https://….trycloudflare.com/homokfutam/` linket (ne a localhostot!), írd be a neved, nyomj **ÚJ SZOBA**-t, és küldd el a meghívó linket. Aki megnyitja, annak a kód már be van írva, csak a **BELÉPÉS** gombot kell megnyomnia.

**B) Állandó link (ingyenes fiók kell)**

`npm run build` után a `dist` mappát töltsd fel Netlifyra, GitHub Pagesre vagy Cloudflare Pagesre. A játék a `/homokfutam/` útvonalon lesz.

### Hogyan megy egy futam

- A szobában mindenki a **KÉSZ VAGYOK** gombot nyomja. Ha mindenki kész, a házigazda indítja a futamot.
- A köröket és a botok erősségét a házigazda állítja (a listában a „házigazda” jelzésű játékos).
- Egy futamon legfeljebb 6 ember indul. A színeket és a rajthelyeket a játék sorsolja.
- Futam közben az **Esc** nem állítja meg a versenyt, csak a menüt hozza fel, a többiek közben mennek tovább.
- Az eredmény akkor jelenik meg, ha minden ember célba ért, legkésőbb 25 másodperccel a te befutód után. Aki még úton van, becsült idővel szerepel.
- Utána **VISSZA A SZOBÁBA**, és jöhet a következő futam.
- Ha valaki kilép futam közben, a podja kiesik. Ha a házigazda lép ki, a botokat a következő játékos gépe veszi át, és a futam megy tovább.

## Irányítás

| Billentyű | Mit csinál |
|---|---|
| W / ↑ | gáz |
| S / ↓ | fék (álló helyzetből tolat) |
| A D / ← → | kormányzás |
| Shift / Space | boost (melegíti a hajtóműveket) |
| C | kamera váltása (3 nézet) |
| R | vissza a pályára |
| Esc / P | szünet (többjátékos módban csak menü) |
| M | hang ki/be |
| N | zene ki/be |
| bármelyik gomb | a rajt előtti bemutató átugrása |

Szünetben a **FOTÓ MÓD** gombbal (csak egyedül) szabadon körbe lehet járni a podot: egérrel forgatod, görgővel közelítesz, Q / E a magasság, F kapcsolja az élességállítást, H elrejti a súgót, Enter elmenti a képet, Esc visszavisz a szünetmenübe.

Kontrollerrel is megy: bal kar a kormány, RT a gáz, LT a fék, X vagy RB a boost, Start a menü, Y a kamera. Telefonon a gáz automatikus, a gombok a képernyő alján vannak.

## Szabályok és tippek

- **Hő:** a boost gyorsít, de melegíti a hajtóműveket. Ha a csík megtelik, a pod túlmelegszik: 3 másodpercig nincs boost, és a végsebesség is kisebb.
- **Tökéletes rajt:** ha a gázt a „RAJT!” előtti utolsó fél másodpercben nyomod le, a pod lendülettel indul.
- **Pálya széle:** a homokon a pod lelassul, a sziklákba ütközni pedig sokba kerül. Az arénában és a kanyonban fal van, attól a pod visszapattan.
- A rekordidődet (pályahossz szerint) és a legjobb körödet a böngésző megjegyzi. Csak az egyéni futamok számítanak bele.

## Grafika és hang

A menüben a **GRAFIKA** sorban négy fokozat van. Az első indításkor a játék a géphez választ: telefonon ALACSONY vagy KÖZEPES, asztali gépen MAGAS. A választást a böngésző megjegyzi, a váltás újratölti az oldalt.

| Fokozat | Mi van benne |
|---|---|
| ALACSONY | utófeldolgozás nélkül, kisebb árnyéktérkép, ritkább részletek és kevesebb néző, a riválisok az egyszerű podot kapják |
| KÖZEPES | bloom, lencsefény, sebességelmosás, színkorrekció, SMAA |
| MAGAS | plusz MSAA, árnyékolás a sarkokban (N8AO), fénysugarak, hőremegés, mélységélesség a menüben |
| ULTRA | nagyobb árnyéktérképek, sűrűbb terep, több részecske |

Ha a gép nem bírja a tempót, a felbontás magától lejjebb megy, és amikor van tartalék, visszaáll.

Teszteléshez az URL-ben is meg lehet adni: `?q=low|medium|high|ultra`, egyes beállítások pedig felülírhatók, például `?gfx=ao:0,heat:0,shadow:1024`.

Mi van a képen:

- **Fény:** alacsonyan álló, aranyórás nap. A visszaverődések az égboltból számolódnak. Az egész pálya árnyéka betöltéskor egyszer elkészül, a kamera közelében pedig a podoknak és a részleteknek külön, éles árnyéka van. A felhők árnyéka végigvonul a homokon.
- **Levegő:** magasságfüggő köd, ami a nap felé melegebb. A távoli hegyek és mezák ettől lesznek kékesek és párásak.
- **Felületek:** valódi PBR-textúrák a Poly Havenről (CC0), WebP-be csomagolva (`assets/tex/`). A terep sűrűsége a pályától mért távolságtól függ. A homokon fodrozódás és a szél vitte homokcsíkok látszanak. Az ideális íven a pálya letaposott és kormos, a széleire befúj a homok, a podok pedig nyomot hagynak rajta, ami fél perc alatt kopik el.
- **Energianyaláb:** a két hajtómű között fehéren izzó mag, körülötte bíbor fény, az oldalán cikázó, elágazó kisülések. Az energia lüktetve fut végig rajta, a végein az emitterek felvillannak és szikráznak. A nyaláb igazi fényt is vet: megvilágítja a hajtóműveket, a pilótafülkét és a homokot. Boostnál vastagabb és fényesebb, túlmelegedéskor narancsosra vált és akadozik, nagy ütközésnél elszakad, az emitterekből kisülések csapnak ki, aztán a nyaláb visszaugrik.
- **Hajtóművek:** a lángcsóva térfogati (sugárkövetéssel számolt) láng, ezért hátulról is lángnak látszik, nem csak egy izzó foltnak. A fúvóka torka izzik, boostnál a láng magja kékesfehér, benne állóhullám-gyémántok. Boost indításakor tűzgyűrű és villanás jön, a végén a láng elköhögi magát és füstöt ereget. Túlmelegedéskor a hajtómű visszalő: tűzgömb, füstkarika, szikrák. A hő a fúvókától előre haladva vörösen izzítja a hajtómű burkolatát. Alacsonyan a homok felett a sugár V alakban felveri a homokot.
- **Füst és tűz:** a por, a füst és a robbanások Blenderben szimulált (Mantaflow) animált képsorok, három irányból megvilágítva, így a nap felől világosak, az árnyékos oldalukon sötétebbek.
- **Ütközések:** a falnál szikrázó súrlódás, kőtörmelék. Nagy ütközésnél tűzgömb, a nyaláb elszakad, a pod festett burkolatdarabjai és alkatrészei leszakadnak és füstölögve pattognak, a pod megrázkódik, és az egyik hajtóműve néhány másodpercig füstöl. Ez csak látvány: a fizikán nem változtat. A visszajátszásban és a többiek gépén is látszik.
- **Egyéb:** a hajtóművek mögött remeg a levegő, a pod alatt fénylik a talaj, és boostnál lökéshullám-gyűrű indul.
- **Kamera:** rugózó üldözőkamera, amely előrenéz a kanyarba és bedől. A rajt előtt bemutató megy (légi felvétel, végig a rajtrácson, majd ráereszkedés a podra). Célba éréskor körbeforduló, lassított felvétel jön, az eredményeknél pedig a futam végének visszajátszása megy TV-kamerákkal.
- **Aréna:** integető és hullámzó közönség, lengő zászlók és molinók, állásjelző kivetítők, reflektortornyok, léghajó és kameradrónok. Célba éréskor tűzijáték és konfetti.
- **Táj:** sorban felvillanó jelzőfények a pálya szélén, kanyarjelző táblák, távvezeték, romok, roncsok, a láthatáron hegyek és egy település. Ördögszekér, száraz bozót, keselyűk és porördögök teszik élővé.
- **Hang:** minden szintetizált: motorok térhatással és Doppler-effektussal, visszhang a kanyonban és az ív alatt, közönség, zene, amely a futam izgalmával erősödik. Ha a böngészőben van magyar hang, a bemondó is megszólal.

## Felépítés

```
homokfutam/
  index.html        menük, HUD, stílus
  main.js           pálya, podok, fizika, botok, verseny, kamera, többjátékos logika
  audio.js          szintetizált hang: motorok, térhatás, zengés, közönség, zene, bemondó
  net.js            P2P szoba (Trystero), üzenettípusok
  playerPod.js      a részletes pod: betöltés, podonkénti festés, mozgó részek
  gfx/quality.js    grafikai fokozatok, dinamikus felbontás
  gfx/atmosphere.js köd, ég, felhők, környezeti fény, az egész pálya árnyéka
  gfx/surfaces.js   terep-, pálya- és kőanyagok (textúrák, triplanáris vetítés)
  gfx/post.js       utófeldolgozás (pmndrs/postprocessing + N8AO)
  gfx/particles.js  részecskék: por, füst, szikra, tűz, konfetti, szimulált füst- és tűzképsorok
  gfx/podfx.js      lángcsóva, fúvókaizzás, boost- és visszalövés-effektek, hőremegés, talajfény, lökéshullám, nyomok a pályán, törmelék
  gfx/beam.js       energianyaláb a hajtóművek között, és a fény, amit vet
  world/dressing.js közönség, zászlók, kivetítők, fények, táj és élővilág
  assets/           a részletes pod modellje és festésmaszkja, assets/tex/ a felületek textúrái,
                    assets/fx/ a füst- és tűzképsorok és a törmelék modelljei
  models/pod/       Blender-szkriptek, ezekből készül a modell
  models/fx/        Blender-szkriptek a füst- és tűzképsorokhoz és a törmelékhez
```

A fontos számok a `main.js`-ben vannak:

- `CTRL`: a pálya kontrollpontjai méterben
- `TOP`: végsebesség (m/s)
- `SKILL`: a botok tempója nehézségi szintenként
- `A_LAT`: mennyire gyorsan veszik be a kanyarokat a botok

## A részletes pod

Minden pod ugyanaz a részletes, kopott modell (`assets/pod_player.glb`), mindegyik a saját rajtszínében. A modell egyszer töltődik be, a podok a geometriát és a textúrákat közösen használják, csak az anyaguk (festés, hőizzás, az emitter fénye) külön. ALACSONY fokozaton csak a te podod részletes, a riválisok az egyszerű podot kapják (`?gfx=rivals:1` bekapcsolja nekik is). Amíg a modell betöltődik, vagy ha nem sikerül betölteni, mindenki az egyszerű podon versenyez.

A modell kódból készül Blenderben (5.2), a forrása a `models/pod/` mappa:

- `build_pod.py`: felépíti a podot (geometria, mozgó részek, kopott anyagok)
- `bake_export.py`: textúrákba égeti a koszt, a kopást és a kormot, majd kiírja az `assets/pod_player.glb` és az `assets/pod_livery.png` fájlt
- `preview.py`: Cycles előnézeti képek a játék kameráinak nézetéből

Újragenerálás a projekt gyökeréből:

```bash
blender -b --factory-startup --python homokfutam/models/pod/bake_export.py
blender -b --factory-startup --python homokfutam/models/pod/preview.py -- out chase hero --glb homokfutam/models/pod/build/pod_raw.glb
```

A `bake_export.py` a `gltfpack` eszközzel (`npx`) tömöríti a modellt, ehhez Node kell. Node nélkül a tömörítetlen fájl kerül az `assets/` mappába.

A festés színét a játék adja: a `pod_livery.png` piros csatornája a fő szín, a zöld csatornája a díszítőszín helye. Így a modell bármelyik rajtszínnel működik, többjátékos módban is. A kék csatorna a hőmaszk: ahol a fém felizzik, amikor a hajtóművek melegszenek (a fúvókában a legerősebb, előre haladva halványul). A nyaláb emitterének elektródája és tekercsei külön anyagot kapnak (`PodBeam`), ezeket a játék a nyalábbal együtt világítja.

A mozgó részeket a `playerPod.js` mozgatja: a beömlő ventilátora a gázzal pörög, fékezéskor kinyílnak a légfékek, kanyarban kitérnek a hátsó lapok és bedől a pilóta, boostnál kitágul a fúvóka, a hajtómű izzása pedig a gázt és a hőt követi.

## Füst, tűz és törmelék

A füst, a por és a robbanások képsorai és a törmelék modelljei is Blenderben készülnek, a forrásuk a `models/fx/` mappa:

- `build_flipbooks.py`: Mantaflow-szimuláció (két porfelhő és egy tűzgömb), Cycles-render, majd 8×8-as képsorok az `assets/fx/smoke.webp` és az `assets/fx/fire.webp` fájlba. A színcsatornák azt tárolják, mennyire világos a felhő jobbról, balról és felülről megvilágítva (a tűznél a harmadik csatorna a láng fénye), az alfa a fedettség. A játék ebből a nap iránya szerint keveri ki a megvilágítást.
- `build_debris.py`: kőtörmelék, leszakadt burkolatdarabok és apró alkatrészek az `assets/fx/debris.glb` fájlba.

Újragenerálás a projekt gyökeréből:

```bash
blender -b --factory-startup --python homokfutam/models/fx/build_flipbooks.py
blender -b --factory-startup --python homokfutam/models/fx/build_debris.py
```

A `build_flipbooks.py` néhány perc (GPU-val), a WebP-tömörítéshez Node kell (`npx sharp-cli`). A szimulációs gyorsítótár és a nyers képkockák a `models/fx/build/` mappába kerülnek.
