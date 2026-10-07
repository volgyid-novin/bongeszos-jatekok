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
| I | FPS-mérő ki/be (a képkockaszám, a képkockaidő, a renderelő és a fokozat a képernyő tetején) |
| G | filmszemcse ki/be |
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
| ALACSONY | utófeldolgozás nélkül, kisebb árnyéktérkép, ritkább részletek és kevesebb néző, a riválisok az egyszerű podot kapják, a sziklák és a tereptárgyak hamarabb váltanak egyszerűbb modellre, és csak a mozgó dolgok (podok, törmelék) vetnek éles árnyékot, a többi árnyéka a betöltéskor sült; a szem a kanyonban és az ív alatt a hely szerint alkalmazkodik |
| KÖZEPES | bloom, lencsefény, sebességelmosás, színkorrekció, SMAA; a szem a hely szerint alkalmazkodik |
| MAGAS | plusz MSAA, árnyékolás a sarkokban (N8AO), fénysugarak, hőremegés, mélységélesség a menüben; élesebb árnyékok több száz méterre előre (a távoli podoké is), napfénnyel átvilágított por a kanyonban és a sziklaív alatt, térbeli felhők, lakkréteg a podok festésén, száraz fűcsomók és több kavics a pálya mellett, sűrűbb por és füst; a képből mért szemadaptáció (a kanyonba érve a szem kitágul, a kijárat kifehéredik), sütött, sugárkövetéssel számolt szórt fény a kanyonban és a sziklaív alatt, délibáb a távoli síkon, érintkezési árnyékok |
| ULTRA | nagyobb árnyéktérképek, sűrűbb terep, több részecske; WebGPU-n a saját pod tükröződése sugárkövetéssel (WebGL-en a valós idejű környezettérkép marad); fizikai alapú égbolt és légköri perspektíva (a távoli sziklák kékes párába vesznek), domborzat a talaj mintázatán közelről, valós idejű tükröződés a saját pododon, részletesebb kanyonfalak és sziklatűk |

Ha a gép nem bírja a tempót, a felbontás magától lejjebb megy, és amikor van tartalék, visszaáll.

Teszteléshez az URL-ben is meg lehet adni: `?q=low|medium|high|ultra`, egyes beállítások pedig felülírhatók, például `?gfx=ao:0,heat:0,shadow:1024`. A MAGAS és az ULTRA fokozat grafikai bővítései egyenként is ki-be kapcsolhatók: `sky`, `csm`, `pom`, `refl`, `vol`, `aoq`, `coat`, `grass`, `geo`, `clouds`, `parts` (például `?gfx=sky:1,grass:0`; mit csinálnak és mennyibe kerülnek: `docs/visual-next-steps.md`, C), valamint a fény bővítései: `noon` (déli fény; `noon:0` a régi, aranyórás), `sunEl` (a nap magassága fokban, kipróbáláshoz), `eye` (szemadaptáció: 0 ki, 1 a képből mérve, 2 a hely szerint), `gi` (sütött szórt fény), `mirage` (délibáb), `sss` (érintkezési árnyékok; `sss:2` hibakereső nézet), `rtr` (sugárkövetett tükröződés a saját podon, csak WebGPU-n), `gloss` (polírozott podok; `gloss:0` a kopott felület, ahogy a modellben van), `tunnel` (alagút a kanyon második felében; `tunnel:0` nélküle). Ezekről: `docs/visual-next-steps.md`, D.

A **RENDERELŐ** sorban WEBGPU és WEBGL közül lehet választani; a váltás újratölti az oldalt, a választást a böngésző megjegyzi. Asztali gépen alapból WebGPU, ha a böngésző támogatja, különben WebGL; telefonon és tableten alapból WebGL. WebGPU-n a three.js WebGPURenderer rajzol, TSL-ben írt anyagokkal és utófeldolgozással. Az élsimítás itt időbeli (TRAA): a homok csillogása, a távoli vezetékek és a kőlapok mozgás közben jóval kevésbé vibrálnak, és nincs szükség MSAA-ra; az árnyékolás a sarkokban GTAO. A WebGPU-s rész csak ilyenkor töltődik le. Cserébe képkockánként kb. háromszor annyi processzoridőt visz el, és lassabban tölt be (a részletek: `docs/visual-next-steps.md`, B), ezért gyengébb gépen a WEBGL lehet a gyorsabb (telefonon ezért az az alapértelmezés). Az URL-ben is megadható: `?renderer=webgpu|webgl`; `?renderer=webgpu-gl` a WebGPURenderer saját WebGL2-es ágát kényszeríti (csak összehasonlításhoz, lassú).

Mi van a képen:

- **Fény:** déli hőség: 30 fokon álló, majdnem fehér nap, rövid, kemény árnyékok, kifakult, krémszínű láthatár. A napos homok és az árnyék között másfél-két fényérték a különbség, mint egy igazi sivatagban, ezért az árnyék tényleg árnyék. A szem alkalmazkodik: a kanyonba érve néhány másodperc alatt kitágul, a kijárat vakítóan fehér, kiérve a sivatag egy pillanatig kiégett, aztán helyreáll. A kanyonban és a sziklaív alatt a szórt fény betöltéskor sütött, sugárkövetéssel számolt fény: mennyi eget lát egy pont, és mennyi fény verődik rá a napsütötte szikláról és homokról (két visszaverődéssel), így a kanyon a saját árnyékában is melegen izzik. A távoli síkon délibáb remeg, a dolgok tövében érintkezési árnyék van. A visszaverődések az égboltból számolódnak, a podok viszont a betöltéskor a pályán sütött fénypróbákból kapják a fényt és a tükröződést (nyílt sivatag, aréna, kanyon, a sziklaív alatt), mindig annak a helynek a próbájából, ahol épp járnak: a kanyonban vörösen verődik vissza rájuk a szikla, az arénában a lelátók tükröződnek rajtuk. Az egész pálya árnyéka betöltéskor egyszer elkészül, a kamera közelében pedig a podoknak és a részleteknek külön, éles árnyéka van. A felhők árnyéka végigvonul a homokon.
- **Ég és szín:** az égbolt színátmenete észlelés szerint egyenletes színtérben (Oklab) keveredik, így a meleg láthatár és a kék zenit között nincs lilás sáv; a nappal ellentétes oldalon a láthatár hűvösebb. A tónusleképezés AgX, mint a Blenderben, így a nap, a lángok és a nyaláb fénye fehérbe fut ki, nem sárgul el.
- **Levegő:** magasságfüggő köd, ami a nap felé melegebb. A távoli hegyek és mezák ettől párásak és kifakultak, a déli hőségben halvány, krémes okker párába vesznek.
- **Talaj:** hét saját, Blenderben sütött felület (fodros homok, puha homok, sivatagi kavicsburkolat, repedezett agyag, letaposott pályahomok, csupasz homokkő, kőlapok), GPU-n tömörített KTX2-textúrákban (`assets/tex/`). A felületek a magasságuk szerint keverednek, így a kavicsok kibújnak a homokból. A mintázat nem ismétlődik láthatóan. Hogy hol mi van, azt a betöltéskor kiszámolt nagy léptékű térkép dönti el: a dűnék szél felőli oldalán fodrok, a csúszólejtőkön puha homok, a lapos mélyedésekben kavics és repedezett agyag, a sziklák körül kavicstörmelék és csupasz kő, mögöttük a szél árnyékában homoknyelv. Ugyanez a térkép adja a nagy léptékű árnyékolást is. Közepes távolságban nagyobb szélfodrok látszanak a dűnéken, ahol a textúra finom fodrai már elmosódnának. A homok csillog a napfényben, a dűnék gerince súroló fényben felragyog.
- **Dűnék:** a pályától távolabb a szél formálta, éles gerincű harántdűnék vannak (hosszú, lankás szél felőli oldal, rövid, meredek csúszólejtő), a gerincekről a szél homokfátylat fúj le. A pálya közelében a terep a régi, a fizika és a köridők nem változnak.
- **Pálya:** letaposott, kavicsos homok, a széleire befúj a homok, a két oldalán a podok által feltolt homokpadka vezet át a dűnékbe. Az ideális íven a pálya sötétebb és kormos, néhol olajfolt és égésnyom maradt az előző futamokból, a kanyonban kibukkan a sziklaalap, az arénában kőlapok vannak. A podok nyoma fél perc alatt kopik el.
- **Sziklák:** a sziklatűk, a buttek, a sziklaív, a kanyon sziklahídja és a kövek Blenderben, kódból készültek (`models/world/`): kemény és puha rétegek, nyakak, sapkakövek, függőleges barázdák és repedések, beégetett árnyékolással, több részletességi szinttel. A tűk rétegei enyhén dőlnek és hullámzanak, a nyakak rétegenként eltérő mélyek, a szél felőli oldalon mélyebbek, így a tűk nem szabályos korongokból rakódnak össze. A kanyon falai a játékban épülnek: a dőlő homokkőrétegekből a puhák beljebb kopnak, a kemények peremként kiállnak, függőleges hasadékok és pillérek tagolják a falat, a színsávok a rétegeket követik. A kanyon második felében kb. 190 méteren sziklatető fedi a hasadékot, három tömbben, a résein napfény hull a porba; alatta sötét van, a kijárat vakítóan fehér. A kanyon alja és a falak töve kevesebb eget lát, ezért sötétebb, a falak a kanyon fénypróbájából kapják a szórt fényt. A tűk lábánál és a kanyonfalak tövében lehullott kőtörmelék van. A sziklák felfelé néző peremein és a tövükben homok gyűlik, a meredek falakon sivatagi lakk (sötét csíkok) fut le.
- **Energianyaláb:** a két hajtómű között fehéren izzó mag, körülötte bíbor fény, az oldalán cikázó, elágazó kisülések. Az energia lüktetve fut végig rajta, a végein az emitterek felvillannak és szikráznak. A nyaláb igazi fényt is vet: megvilágítja a hajtóműveket, a pilótafülkét és a homokot. Boostnál vastagabb és fényesebb, túlmelegedéskor narancsosra vált és akadozik, nagy ütközésnél elszakad, az emitterekből kisülések csapnak ki, aztán a nyaláb visszaugrik.
- **Hajtóművek:** a lángcsóva térfogati (sugárkövetéssel számolt) láng, ezért hátulról is lángnak látszik, nem csak egy izzó foltnak. A fúvóka torka izzik, boostnál a láng magja kékesfehér, benne állóhullám-gyémántok. Boost indításakor tűzgyűrű és villanás jön, a végén a láng elköhögi magát és füstöt ereget. Túlmelegedéskor a hajtómű visszalő: tűzgömb, füstkarika, szikrák. A hő a fúvókától előre haladva vörösen izzítja a hajtómű burkolatát. Alacsonyan a homok felett a sugár V alakban felveri a homokot.
- **Füst és tűz:** a por, a füst és a robbanások Blenderben szimulált (Mantaflow) animált képsorok, három irányból megvilágítva, így a nap felől világosak, az árnyékos oldalukon sötétebbek.
- **Ütközések:** a falnál szikrázó súrlódás, kőtörmelék. Nagy ütközésnél tűzgömb, a nyaláb elszakad, a pod festett burkolatdarabjai és alkatrészei leszakadnak és füstölögve pattognak, a pod megrázkódik, és az egyik hajtóműve néhány másodpercig füstöl. Ez csak látvány: a fizikán nem változtat. A visszajátszásban és a többiek gépén is látszik.
- **Egyéb:** a hajtóművek mögött remeg a levegő, a pod alatt fénylik a talaj, és boostnál lökéshullám-gyűrű indul.
- **Kamera:** rugózó üldözőkamera, amely előrenéz a kanyarba és bedől. A rajt előtt bemutató megy (légi felvétel, végig a rajtrácson, majd ráereszkedés a podra). Célba éréskor körbeforduló, lassított felvétel jön, az eredményeknél pedig a futam végének visszajátszása megy TV-kamerákkal.
- **Aréna:** faragott homokkő lelátók fapadokkal, vakolt hátsó fal pártázattal, boltíves fülkékkel tagolt mellvéd, csíkos vászontetők a középső lelátók felett, kupolás kapubástyák és a rajtkapu (Blenderben modellezve, közös arénatextúrákkal). A mellvéd fülkéiben és a kapukban nem fekete lyuk van, hanem mögöttük egy-egy terem látszik: a bejáratnál a padlóra süt a nap, beljebb meleg félhomály, és ahogy a kamera mozog, a mélysége is látszik. A közönség Blenderben renderelt alakokból áll (négy testalkat, három karállás, `models/world/build_crowd.py`); mindenki saját inget, bőrszínt, hajat és nadrágot kap, ülve a padsor mögött csak a felsőteste látszik. Integető és hullámzó közönség, lengő zászlók és molinók, állásjelző kivetítők, reflektortornyok, léghajó és kameradrónok. Célba éréskor tűzijáték és konfetti.
- **Táj:** kanyarjelző táblák, távvezeték, romok, roncsok és egy település. A földön kavicsok, kövek, száraz cserjék, régen elpusztult állatok csontjai és lezuhant podok roncsdarabjai. Ördögszekér, száraz bozót, keselyűk és porördögök teszik élővé. A kanyonban és a sziklaív alatt por lebeg, ahol a napfény átvilágít rajta, fénynyalábok látszanak.
- **Láthatár:** a távoli hegyláncokat Blender rendereli egy 360 fokos képsávba, a játék napállásával megvilágítva. A játék egy gyűrűre teszi a pálya köré, és ugyanaz a köd párásítja, mint minden mást.
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
  gfx/backend.js    melyik renderelő rajzol (?renderer=webgpu), a közös uniformok, a WebGPU-s rész késleltetett betöltése
  gfx/tsl/          a WebGPU-s ág anyagai és utófeldolgozása TSL-ben (ugyanaz, mint a GLSL-es, a fájlnevek megegyeznek)
  gfx/atmosphere.js köd, ég, felhők, környezeti fény, az egész pálya árnyéka, a közepes távolság gyorsítótárazott árnyéka;
                    a napállás és a színek (déli és aranyórás fény)
  gfx/eye.js        szemadaptáció: a fénymérés kiértékelése és az expozíció követése
  gfx/gi.js         a sütött szórt fény betöltése és kiolvasása az anyagokban (assets/world/gi.bin)
  gfx/gibake.js     a szórt fény sütése (csak fejlesztéshez: ?bakegi letölti a gi.bin-t), gfx/bvh.js a sugárkövetés gyorsítóstruktúrája
  gfx/screen.js     a két utófeldolgozás közös segédei (a láthatár a képen, az érintkezési árnyékok beállításai)
  gfx/skylut.js     a fizikai alapú égbolt táblázatai (Hillaire), betöltéskor sütve, külön szálon (skylut.worker.js)
  gfx/ground.js     talaj-, pálya- és sziklaanyagok: a KTX2-textúratömbök, a felületek keverése, csillogás,
                    homok a sziklákon, nyomok a pályán
  gfx/surfaces.js   triplanáris kőanyag a régi kőtextúrával (csak tartalék)
  gfx/post.js       utófeldolgozás (pmndrs/postprocessing + N8AO)
  gfx/probes.js     a podok fénypróbái: a pálya néhány pontjáról sütött környezeti fény, és a keverésük a podok anyagaiban;
                    a saját pod valós idejű környezete (tükröződés)
  gfx/particles.js  részecskék: por, füst, szikra, tűz, konfetti, szimulált füst- és tűzképsorok
  gfx/podfx.js      lángcsóva, fúvókaizzás, boost- és visszalövés-effektek, hőremegés, talajfény, lökéshullám, nyomok a pályán, törmelék
  gfx/beam.js       energianyaláb a hajtóművek között, és a fény, amit vet
  gfx/fxbatch.js    a podok apró effektdarabjai (fúvókatorok, lángfények, a nyaláb végei, talajfény és -árnyék) egyetlen rajzolással, nem podonként
  world/dressing.js közönség, zászlók, kivetítők, fények, táj és élővilág
  world/macro.js    a betöltéskor sütött nagy léptékű talajtérkép (árnyékolás, gerincek, mélyedések, sziklák környéke)
  world/rocks.js    a szikla- és arénamodellek betöltése, részletességi szintek
  world/scatter.js  kavicsok, kövek, cserjék, csontok, roncsdarabok
  world/grass.js    száraz fűcsomók a pálya mentén, szélben ringatózva
  world/horizon.js  a láthatár hegyláncai
  world/haze.js     por és fénynyalábok a kanyonban és az ív alatt
  assets/           a részletes pod modellje és festésmaszkja, assets/tex/ a felületek textúrái,
                    assets/world/ a pálya modelljei és a láthatár, assets/fx/ a füst- és tűzképsorok
                    és a törmelék modelljei
  models/pod/       Blender-szkriptek, ezekből készül a modell
  models/fx/        Blender-szkriptek a füst- és tűzképsorokhoz és a törmelékhez
  models/world/     Blender-szkriptek a pálya textúráihoz, szikláihoz, arénájához, tárgyaihoz és a láthatárhoz
  tools/            mérő- és sütőszkriptek fejlesztéshez (headless Chrome): teljesítménymérés, képösszevetés,
                    a szórt fény sütése; leírás: tools/README.md
```

A fontos számok a `main.js`-ben vannak:

- `CTRL`: a pálya kontrollpontjai méterben
- `TOP`: végsebesség (m/s)
- `SKILL`: a botok tempója nehézségi szintenként
- `A_LAT`: mennyire gyorsan veszik be a kanyarokat a botok

## A részletes pod

Minden pod ugyanaz a részletes, kopott modell (`assets/pod_player.glb`), mindegyik a saját rajtszínében. A megmaradt festés és a csupasz fém polírozott (a te podod teljesen, a riválisoké változóan), a kopások, a korom és a gumi matt marad, így a podokon látszik, mi tükröződik rajtuk. A modell egyszer töltődik be, a podok a geometriát és a textúrákat közösen használják, csak az anyaguk (festés, hőizzás, az emitter fénye) külön. Betöltéskor a játék anyagonként egyetlen hálóba fűzi a részeit, a mozgó részek ebben csontként mozognak, így egy pod négy rajzolás (korábban kb. huszonnégy). ALACSONY fokozaton csak a te podod részletes, a riválisok az egyszerű podot kapják (`?gfx=rivals:1` bekapcsolja nekik is). Amíg a modell betöltődik, vagy ha nem sikerül betölteni, mindenki az egyszerű podon versenyez.

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

## A pálya textúrái és modelljei

Minden Blenderben, kódból készül, a forrás a `models/world/` mappa:

- `build_textures.py`: a talaj, a sziklák és az aréna felületei. A domborzatot, a színt és az érdességet numpy rajzolja meg (ismétlődő, varratmentes mintákkal, a kavicsok valódi 3D kövek), a Cycles pedig ráégeti egy síkra: szín, érdesség, normál, árnyékolás, magasság. Az eredmény 1024 pixeles KTX2-textúratömb: a szín ETC1S, a normál UASTC tömörítésű (a KTX-Software `toktx` eszközével).
- `build_rocks.py`: sziklatűk, buttek, a sziklaív, a kanyon sziklahídja, kövek és kőtörmelék-kupacok (`assets/world/rocks.glb`). A `-- --hi 1` kapcsolóval csak a sziklatűket készíti el, egy részletességi szinttel feljebb (`assets/world/rocks_spires_hi.glb`, ULTRA fokozaton tölt be).
- `build_arena.py`: a lelátók mellvédje, a vászontetők, a pártázat, a kapubástyák és a rajtkapu (`assets/world/arena.glb`).
- `build_props.py`: kavicsok, kövek, cserjék, csontváz, csontok, roncsdarabok (`assets/world/props.glb`).
- `build_crowd.py`: a közönség alakjai egy képsorban (`assets/crowd_atlas.png`), négy testalkat és három karállás.
- `build_panorama.py`: a láthatár hegyláncai (`assets/world/panorama.ktx2`); a `-- --noon 1` kapcsolóval a déli napállással (`panorama_noon.ktx2`).

A szórt fény (`assets/world/gi.bin`) nem Blenderben, hanem a játékban sül: `?bakegi` az URL-ben betölti a pályát, sugárkövetéssel kiszámolja a kanyon és a sziklaív fényét (kb. két perc), és letölti a fájlt. Akkor kell újrasütni, ha a pálya, a sziklák vagy a napállás változik.
- `preview.py`: Cycles előnézet a modellekről.

Újragenerálás a projekt gyökeréből:

```bash
blender -b --factory-startup --python homokfutam/models/world/build_textures.py
blender -b --factory-startup --python homokfutam/models/world/build_rocks.py
blender -b --factory-startup --python homokfutam/models/world/build_rocks.py -- --hi 1
blender -b --factory-startup --python homokfutam/models/world/build_arena.py
blender -b --factory-startup --python homokfutam/models/world/build_props.py
blender -b --factory-startup --python homokfutam/models/world/build_panorama.py
```

A textúrákhoz kell a [KTX-Software](https://github.com/KhronosGroup/KTX-Software) (`toktx`), a modellek tömörítéséhez Node (`npx gltfpack`). A textúrák kb. 10–15 perc alatt sülnek (GPU-val), a `--only sand_ripple,gravel` csak a megadottakat süti újra, a `--repack 1` csak a KTX2-fájlokat készíti el újra a már megsütött anyagokból. A nyers sütések a `models/world/build/` mappába kerülnek.

A sziklák elhelyezése és ütközői a `main.js`-ben vannak. Ha a modellek nem töltődnek be, a játék a régi, egyszerű formákkal fut.

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
