# PAJZSUGRÁS

UT2004 hangulatú trükkugrós időfutam a böngészőben. A pályákat a beépített szerkesztővel építed, a játék pedig a szerkesztőből kiexportált pályákat építi be (lásd lent), saját mozgásmotorral: dupla ugrás, kiugrás, falról kiugrás, átlós ugrás, és mindenekelőtt a **pajzsugrás**, vagyis a pajzslöket, amivel a saját ugrásodat tolod meg. A mozgás a UT2004-et követi: nincs bunnyhop és nincs strafe-gyorsulás, a sebességet a technikák adják, a nehéz részeken pedig csak a technikák **kombinációja** visz át. Nincs lövöldözés és nincsenek botok: te vagy az óra ellen, a saját rekordod szelleme ellen, vagy haverokkal egy szobában ugyanazon a pályán.

Játékszerver nincs: a szobában a böngészők közvetlenül kapcsolódnak egymáshoz (WebRTC, Trystero/Nostr), a globális ranglista pedig nyilvános Nostr relékre épül.

## Indítás

A projekt gyökérmappájából (`D:\izsi\lol`):

```bash
npm install
npm run dev
```

Utána nyisd meg: http://localhost:5173/pajzsugras/ (vagy a `.claude/launch.json` `pajzsugras` bejegyzésével, ami az 5215-ös porton indítja). Chrome, Edge vagy Firefox kell hozzá az egér befogása miatt.

Állandó online link: **https://volgyid-novin.github.io/bongeszos-jatekok/pajzsugras/**

## Irányítás

| Billentyű | Mit csinál |
|---|---|
| W A S D | mozgás |
| Egér | körbenézés (az egér befogódik, a nyers mozgást használja, ahol a böngésző engedi) |
| Space | ugrás, a levegőben dupla ugrás |
| 2× koppintás W / A / S / D | kiugrás az adott irányba |
| Shift | nincs funkciója: sprint nincs, mindig teljes sebességgel futsz, mint a UT2004-ben |
| Bal egérgomb nyomva | pajzs töltése (kb. 1,2 mp alatt tele), elengedéskor lökés |
| V | külső / belső nézet váltása (lásd lent); a Beállításokban is megadható |
| R | vissza az utolsó ellenőrzőpontra |
| Enter | a pálya újrakezdése |
| Tab | eredménytábla (szobában) |
| Esc | szünet menü |

Az óra az **első gombnyomásra** indul. Ha leesel, lávába vagy lézerbe lépsz, azonnal visszakerülsz az utolsó ellenőrzőpontra, az idő közben is megy.

## Technikák

- **Dupla ugrás**: a levegőben még egyszer Space. **Mindig ugyanakkora** (a felfelé sebességed 7,3 m/s lesz) és **bármikor elsül**, nincs időablak, nincs elnyelt lenyomás. Levegőnként egyszer megy, földetéréskor és falról kiugrás után újra megvan. A csúcson a leghatásosabb. Három kivétel van: (1) ha még gyorsabban emelkedsz 7,3 m/s-nál (közvetlenül egy pajzsugrás vagy ugrópárna után), a lenyomás nem csinál semmit és nem is használódik el, különben megvágná a nagy ugrást; (2) az átlós ugrás ablakában, vagyis ha a Space a földi kiugrás után legfeljebb kb. 0,07 mp-cel (8 tick) érkezik, a dupla ugrás nem azonnal sül el, hanem a csúcsra vár; (3) a pajzs-kombóban, vagyis ha a Space a földről indított pajzslökés után legfeljebb kb. 0,08 mp-cel (10 tick) érkezik, a lökés tetejére egy sima ugrás adódik a dupla ugrás helyett (és fordítva: ha a lökés az ugrás után ugyanennyi időn belül érkezik, a teljes ugrás magasságára adódik rá). A falról kiugrás a (2) és a (3) ablakot is lezárja: utána a Space mindig azonnali dupla ugrás, és a pajzs a falról kiugrás rögzített magasságára ad rá, nem a sima ugrás magasságára.
- **Kiugrás**: dupla koppintás egy irányra. Gyors, alacsony ugrás, 13,2 m/s. Földetérés után kb. 0,35 mp-et várni kell a következőre.
- **Kiugró ugrás**: kiugrás, majd a levegőben dupla ugrás. Ez viszi a legmesszebbre (kb. 14 m).
- **Falról kiugrás**: a levegőben, fal közelében (kb. 0,6 m-en belül, a hátad mögött vagy az oldaladnál; a hely a testmagasság bármelyik részén lehet) kiugrás. Légterenként egyszer megy, ugrás, kiugrás vagy átlós ugrás után is. **Mindig ugyanolyan magas** (4,2 m/s felfelé, kb. fél méter), a kiugrás irányában 13,2 m/s, és **visszaadja a dupla ugrást**: falról kiugrás után mindig ugorhatsz még egyet, akkor is, ha a dupla ugrást már elhasználtad (ugrás, dupla ugrás, falról kiugrás, dupla ugrás). A SPACE rá mindig azonnal dupla ugrás (az átlós ugrással ellentétben nincs betárolt, magától jövő ugrás): minél később nyomod, annál messzebbre visz.
- **Felvonós ugrás**: mozgó padlóról elugorva a padló sebessége hozzáadódik az ugrásodhoz.
- **Pajzsugrás**: nézz lefelé, tartsd a bal gombot, majd Space és a gomb elengedése egyszerre (a sorrend mindegy, ha 80 ms-on belül van). A lökés a töltéstől függ: rövid kattintás kb. 2,3 m, teljes töltés kb. 6,5 m magas ugrást ad. A pajzs 2,4 m-en belüli felületre hat.
- **Pajzs + dupla ugrás**: a pajzsugrás csúcsán még egy dupla ugrás, kb. 8 m magasra visz.
- **Fali lökés**: a levegőben töltött pajzzsal egy közeli falra lőve a lökés elfelé visz a faltól.
- **Futó pajzsugrás**: futás közben hátra és ferdén lefelé (kb. 50°) lőve a lökés vízszintes sebességet ad a futásodhoz: kb. 21 m-es ugrás, a csúcson dupla ugrással kb. 28 m.
- **Átlós ugrás**: W-t tartva koppints kétszer A-ra vagy D-re, és vele egyszerre nyomd a Space-t (előbb vagy később is jó, kb. 0,07 mp-en belül). A kiugrás a futásod mellé adódik, ezért kb. 15,9 m/s-mal, a futási irányodhoz képest 56°-kal oldalra indulsz, a dupla ugrás pedig magától jön a csúcson: kb. 16,6 m-t visz (a sima kiugró ugrás 13,9, a futó ugrás dupla ugrással 11). Ugrás után nézz a cél felé: a W oda húzza az ugrást. Ezért a sáv, amin nekifutsz, a cél irányától oldalra áll.
- **Kombók**: a nehéz részeken egy technika nem elég. Például átlós ugrás + falról kiugrás, pajzsugrás + falról kiugrás + dupla ugrás, átlós ugrás + pajzs a falon, ugrás a falnak + falról kiugrás a sarkon át. A falról kiugrás visszaadja a dupla ugrást, ezért az ugrás, dupla ugrás, falról kiugrás, dupla ugrás lánc is megy.
- **Nincs bunnyhop, nincs strafe-gyorsulás**: csak az új Space-lenyomás ugrik (a tartott Space nem), és minden elugrás (ugrás, kiugrás, pajzs) a földön legfeljebb futósebességgel (8,8 m/s) indul: a landolás előtti lendületet az elugrás eldobja. A levegőben az irányítás kormányoz, de nem gyorsít: a sebesség felső határa az eddigi sebességed vagy 8,8 m/s, amelyik nagyobb.
- **Ugrópárna**: rálépsz, és a célig repít. A levegőben irányíthatod magad.

## Pályák

A beépített pályák a **pályaszerkesztőből kiexportált** pályák (lásd lent): minden beépített pálya egy `pajzsugras/maps/<azonosító>.js` fájl, ami a szerkesztő pályafájlja (sima JSON, `export default { ... }`), és a `maps/index.js` sorolja fel őket. Jelenleg egy van: **Új pálya** (`uj-palya`). A nyolc régi, kézzel írt pálya (KIKÉPZÉS ... ORBITÁLIS) megszűnt, a szerkesztő egyetlen témája (a KIKÉPZÉS ege, köde, fényei és színei) maradt meg, ezt használja minden pálya; a régebben mentett pályák, amelyek más témát neveztek meg, ugyanúgy betöltődnek, ezzel a témával.

A beépített pálya normál pálya: ott van a **JÁTÉK** képernyőn, a szobában választható, és a globális ranglistán is van tabja. Mivel a kiexportált pályának nincs bizonyító útvonala, nincs szerzői ideje sem: **nincs érem** (a HUD, az eredmény és a pályakártya nem mutat érmet és nehézséget; a ranglistán nincs érem oszlop), a ranglista hihetőségi alsó határa pedig **max(3 mp, a pálya geometriai alsó határa)** (szerzői idővel rendelkező pályán a szerzői idő fele). A geometriai alsó határ a rajttól az ellenőrzőpontokon át a célig vezető legrövidebb vízszintes út (egyenesen, doboztól dobozig mérve, a magasság nem számít) osztva 30 m/s-mal, ugrópárnás vagy mozgó padlós pályán 60 m/s-mal (`sim/world.js` `routeFloor`); a szobában a futam legfeljebb 180 mp, és ott a fix 3 mp az alsó határ. Ha a pályának még nincs célja, játék közben szabadon ugrálhatsz rajta, a futam nem ér véget (a pálya betöltésekor üzenet jelzi); az ilyen pálya nincs fent a ranglistán (ha egyik pályának sincs célja, hogy ne legyen üres a képernyő, mind fent van), a szobában pedig nem választható („Ennek a pályának még nincs célja.”). Az `npm run add-map` ilyenkor is felveszi, de figyelmeztet.

### Az Új pálya szakaszai

Az **Új pálya** első része (a rajttól az E platformig, a 3. ellenőrzőpontig) a pálya készítőjének saját munkája, **változatlan**. Utána öt, egyre nehezebb szakasz következik; mindegyik elején ellenőrzőpont áll (összesen 7), a végén a cél. Az első három tanít, a másik kettő már csak kombóval járható, egyetlen technika nem éri el:

1. **S1, átlós ugrás**: 15 m rés az E platformról a P1-re (ugyanazon a magasságon). Sima ugrás, dupla ugrás és kiugrás nem éri át; a kiugró ugrás (előre kiugrás + dupla ugrás) viszont igen, ez a könnyű, tanító szakasz.
2. **S2, ugrás + dupla ugrás + falról kiugrás előre a W2 fal mentén + dupla ugrás**: a P1-ről a 11 m-re lévő, 4 m-rel magasabb G2-re.
3. **S3, futó pajzsugrás + dupla ugrás**: 24 m rés, a G3 2 m-rel magasabban van. A G2 platform csak 8 m hosszú, ezért a pajzsot már futás közben töltsd (a töltés 1,2 mp), és az utolsó métereken engedd el.
4. **S4, pajzsugrás egyenesen fel + dupla ugrás + falról kiugrás a W4 faltól el + dupla ugrás**: a G4 9,25 m-rel a G3 fölött van, a fal tövétől 6,5 m-re kezdődik. Egyetlen technika sem visz kb. 8,7 m-nél magasabbra (a legmagasabb egyszeri pajzsugrás: a pajzs elengedése után 10 ticknyivel nyomod a Space-t, mert a kettő még összeadódik).
5. **S5, sarokfolyosó**: futó pajzsugrás a 22 m hosszú folyosón (+z), a folyosó végén az F falnál oldalra (+x) falról kiugrás, majd dupla ugrás a nyíláson át a G5 platformra, ahol a cél van. A 7. ellenőrzőpont a G4 egész tetejét lefedi, így a folyosó előtt bárhol állsz, megvan.

A kapuk tesztje (`test/uj-palya-gates.mjs`, `npm run test:pj -- --gate=S`) mindegyik szakaszra bizonyítja, hogy a kombó célba ér (pontosan és „sloppy” futással is), és hogy a felsorolt egyetlen technikák nem; az S1–S3 tiltólistájában nincs pajzsugrás (az átugorhat belőlük, ezek tanító szakaszok), az S4 és S5 mindent tilt. Ugyanott egy útvonal is fut az S1–S5 megoldásokból, az E platformtól a célig (a bot kb. 18,5 mp alatt ér célba). A bizonyítás erre a pályára (az ujjlenyomatára) szól: ha újraexportálod, vagy a fizika változik (a `SIM_VER` is az ujjlenyomatban van), a teszt hibával leáll, amíg a kapukat újra nem bizonyítod és a `PROVED_HASH`-t át nem írod. A saját mászásod (a 2. platformról a 12 m magas sávra) is megy a pajzzsal: a padlóra lőtt első lökés, dupla ugrás a csúcson, újratöltés, második lökés a falnak (-55 és -75° közötti dőléssel), falról kiugrás a faltól el, dupla ugrás (a mért időzítés-változatok kb. 82%-a célba ért). Helyben (localhostról) a pálya egy másolata, az **Új pálya (folytatás)** magától megjelenik a szerkesztő Saját pályái között.

### Új beépített pálya (vagy a meglévő frissítése)

1. A szerkesztőben **Exportálás**: letölt egy `pajzsugras-<név>.json` fájlt.
2. A projekt gyökeréből:

```bash
npm run add-map -- ~/Letöltések/pajzsugras-uj-palya.json            # az azonosító a pálya nevéből készül ("Új pálya" -> uj-palya)
npm run add-map -- ~/Letöltések/pajzsugras-uj-palya.json uj-palya   # megadott azonosítóval: ha már van ilyen, a pálya frissül (a sorrendje nem változik)
```

A szkript (`tools/add-map.mjs`) ugyanazzal az ellenőrzéssel olvassa a fájlt, mint a szerkesztő importja, egyszer felépíti a pályát, és mindkét generált szöveget (a pálya fájlját és az új `maps/index.js`-t) szintaxis-ellenőrzésnek veti alá, mielőtt bármit kiírna (hibás fájl, azonosító vagy regiszter esetén semmi nem változik), kiírja a `maps/<azonosító>.js` fájlt (a pálya adata csak adatként van benne, a neve sehol nem kerül megjegyzésbe vagy kódba), és az új pályát a `maps/index.js` `<add-map ...>` jelölői közé veszi fel (az új pálya a lista végére kerül; a sorrend adja a pálya sorszámát; az import neve `map_<azonosító>`, a kötőjelek aláhúzásra cserélve). Az azonosító kisbetűs betűkből és számokból áll, a csoportokat egy-egy kötőjel választja el (`a-b2`, nem `a--b` vagy `abc-`), legfeljebb 31 jel, nem kezdődhet `sajat-`-tal, és nem lehet `index`, `themes` vagy Windows eszköznév (`con`, `nul`, `com1` ...). A `maps/index.js` a beolvasáskor minden beépített pálya fájlját megtisztítja a szerkesztő importjának korlátaival (méretek, elemszám, a név), a lista üres is lehet (a játék ilyenkor a főmenüvel és a szerkesztővel indul). Utána `npm run test:pj` ellenőrzi a pályát (érvényes test, a rajt a földön áll, nincs benne halálzónában járható felület, véletlen bemenetekkel nem akad el és nem kerül falba, determinisztikus). A pálya ujjlenyomata a geometriából jön: egy újraexportált, megváltozott pályán a régi rekordok eltűnnek.

### Érmek

Érem csak olyan pályán van, aminek van bizonyító útvonala (szerzői idő, A): **Szerző** (megdöntöd A-t), **Arany** (1,15 × A), **Ezüst** (1,4 × A), **Bronz** (1,9 × A), és a HUD mindig a következő megszerezhető érem idejét mutatja. A szerkesztőből exportált pályák nem ilyenek, a bot a szimuláció tesztjeiben szintetikus pályákon fut (`test/synth.mjs`, `test/probes.js`).

## Saját rekord és szellem

Minden pályához a böngésződben tárolódik a legjobb idő, a részidők és a futás felvétele. A következő futásnál az **áttetsző szellem** mutatja a rekordodat, és minden ellenőrzőpontnál zöld (gyorsabb) vagy piros (lassabb) különbség jelenik meg. A szellem a beállításokban kikapcsolható. A rekordok a `pajzsugras:*` localStorage kulcsokban vannak; ha egy pálya geometriája megváltozik, a régi rekord eltűnik (a pálya ujjlenyomata más lesz), így nem lehet régi idővel összehasonlítani.

## Beállítások

Név (legfeljebb 16 karakter), egér érzékenység, látómező (alapérték 100° vízszintesen), nézet (belső / külső), billentyű-kijelző (Defrag stílus), szellem, grafika, hangerő. (A helyi UT2004-fájlokhoz nincs kapcsoló: a saját gépeden, a fejlesztői szerveren maguktól bekapcsolnak, ha megvannak; lásd a Hangok résznél.)

### Külső nézet (V)

Játék közben a **V** billentyű (vagy a Beállítások > Megjelenítés > **Nézet: belső / külső**) a UT2004 *behindview*-jához hasonló, harmadik személyű kamerára vált. A beállítás megmarad a böngészőben (a V is ezt váltja). A szerkesztőben és szövegmezőben a V nem vált (a szerkesztőben a kijelölő eszköz billentyűje), a szerkesztő próbafutásában viszont igen.

- **Kamera**: a fejed körül kering, ugyanazzal a nézőszöggel (egér), mint az első személyű: 3,5 m-rel mögötted a nézés irányában és 0,35 m-rel fölötte, így lefelé nézve a kamera fölédkerül, felfelé nézve alád (a pajzsugráshoz lefelé kell nézni, ez is látszik). A kamera nem megy át a falon, padlón vagy mennyezeten: a fejtől a kívánt helyig a szimuláció ütközési világában egy 0,15 m-es dobozt húz végig, és 0,1 m-rel a találat előtt megáll. Befelé azonnal húz (különben a fal belseje látszana pár képkockán át), kifelé kb. 1/6 mp időállandóval lassan engedi ki, hogy ne ugráljon.
- **Figura**: a saját Gorge figurád (a robot, ha nincs meg a helyi modell) látszik, a szimuláció interpolált helyzetével, irányával és jelzőivel hajtva: fut, ugrik, dupla ugrik, kiugrik, a pajzs töltésekor a pajzsgömb is körülveszi. Tömör (nem áttetsző), árnyékot vet, nincs névcímke és nyomvonal. Ha a kamera 0,8 m-nél közelebb kerül a fejedhez (fal szorítja be), a figura eltűnik, és 1,0 m fölött jelenik meg újra (nem villog). Csak helyben látszik: első személyű nézetben, a menüben, a szerkesztőben és mások képén nincs saját figura.
- **Fegyver és HUD**: az elsőszemélyű pajzskesztyű nem látszik, de a figura kezében ott a UT2004 pajzsfegyver (lásd lent); a célkereszt és a HUD marad. A pajzs célzása változatlanul a szemedből indul; a célkereszt a kamera képének közepe, ami távoli célnál ugyanoda mutat, közelinél legfeljebb 0,35 m-rel fölötte.

Grafika szintek:

- **Alacsony**: nincs utófeldolgozás, 1× felbontás, nincs árnyék, kisebb textúrák. Gyenge gépekre.
- **Közepes** (alap): fényvirág (bloom), élsimítás, 1024-es árnyéktérkép a játékos körül.
- **Magas**: 4× MSAA, nagy felbontás, 2048-as árnyéktérkép, 16× anizotróp szűrés.

## Hangok

A játék saját hangjai kódból számítottak (nincs bennük felvétel vagy más játékból átvett hang): a `tools/gen-sounds.mjs` hangszintézis-receptekből (oszcillátorok, szűrt zaj, rezgésmódok, telítés, visszhang, fix magú véletlenszám-generátor) 24 kHz-es, mono, 16 bites WAV fájlokat ír a `pajzsugras/assets/sounds/` mappába, és egy `index.js`-t, amit az `audio.js` tölt be; a Vite külön, hash-elt fájlként csomagolja őket. Újragenerálás: `npm run gen:pj-sounds` (a fájlok bájtra azonosak lesznek, ezt a teszt ellenőrzi). Összesen kb. 430 kB, a csúcs −1,5 dBFS. Amelyik hang nem töltődött be, ott a szintetizált tartalék szól, a menü kattanása mindig élő szintézis. A pajzstöltés két fájl: a töltés emelkedése a `CHARGE_T` (1,2 s) ideig tart, és pontosan oda ér, ahol a végtelenített „töltve” zümmögés kezdődik; elengedéskor mindkettő elhalkul.

**Helyi UT2004-hangok (opcionális, csak a saját gépeden).** Kapcsoló nincs: ha a játék a fejlesztői szerveren fut a saját gépeden (`npm run dev`, `localhost`), a `pajzsugras/local-sounds/` mappába tett WAV fájlokat a játék a saját hangjai helyett játssza le, például a saját UT2004 vagy UT99 telepítésed hangjait. A mappában egy `sounds.json` sorolja fel őket fajtánként: `charge` (pajzstöltés), `fire` (pajzslökés), `jump` (ugrás és dupla ugrás), `dodge` (kiugrás és falról kiugrás), `step` (lépések és földetérés); egy fajtához több fájl is adható, ezeket véletlenszerűen váltogatja. Lista nélkül csak a `shield-charge.wav` és a `shield-fire.wav` fájlt keresi. A mappa a `.gitignore`-ban van: ezek a fájlok soha nem kerülnek a repóba és az élő oldalra, mert mások szerzői joggal védett hangjait nem terjeszthetjük. Ha nincsenek ott, marad a beépített hang. A hangokat és a Gorge modellt egy szkript nyeri ki a saját telepítésedből, lásd a következő részt.

## A pajzskesztyű

Az elsőszemélyű fegyver a játék saját **pajzskesztyűje**, teljes egészében kódból építve (nincs hozzá modellfájl, textúra-fájl vagy más játékból átvett elem): a `render/hardkit.js` kemény felületű elemekből (lekerekített és letört élű lemezek, esztergált alkatrészek, kábelek, csavarok) épít, a `render/armour-mats.js` adja az anyagokat (játékosszínű zománc, gunmetal váz, acél, gumi, világító szegély), a `render/gauntlet.js` állítja össze. Az építés determinisztikus (fix magú véletlenszám, nincs `Math.random`), és Node-ban is lefut, így tesztelhető.

- **Felépítés**: rétegzett páncélház (a lemezek keretlemezeken ülnek, 7 mm-es varrattal), térdvédő lemezek, a tápcella az ablaka alatt, hűtőbordák a vállakon, kábelek, harmonika a csuklón, elöl az emitter: gyűrűs tányér hatszögű lencsével, három szarvval és a körbefutó fényláncgyűrűvel. Első személyben 10–20 ezer háromszög (kb. 20 ezer, a karvédővel), harmadik személyre 2–3 ezres változat készül (`buildGauntlet({ lod: 'tp' })`).
- **Viselkedés**: töltéskor a szarvak 10°-ig kinyílnak, a fegyver finoman remeg, a gyűrűk, a mag és a tápcella egyre fényesebb, a cella gyorsabban lüktet; lökéskor a szarvak becsapódnak, a bordák felizzanak és 0,6 mp alatt kihűlnek, a mag felvillan. A pajzsburok, a torkolattűz és a rugós mozgás (visszarúgás, ugrás, kitérés) a `render/viewmodel.js`-ben marad.
- **Elhelyezés**: a kesztyű jobb alul látszik, kb. 0,5 m-re a kamerától, kicsit a közép felé fordítva, a képet a nézetkamera objektívelcsúsztatása viszi a sarokba: főleg az emitterfej látszik, a kar a kép aljáról kifut.
- **Bemutató** (csak a fejlesztői szerveren, a saját gépeden): `http://localhost:5173/pajzsugras/?vitrin` a kesztyűt forgótányéron mutatja, töltéscsúszkával és lövés gombbal, tárgy- és elsőszemélyes nézetben (`render/vitrin.js`; a build-be nem kerül be). A `window.__vitrin` a szkriptelt ellenőrzésre való.
- A UT2004 pajzsfegyvere (lásd lent) magától lecseréli, az élő oldalon is; kapcsoló nincs. Ha a fegyver modellje nem töltődik be, a pajzskesztyű marad.

## Gorge és a hangok kinyerése

A többi futót a UT2004 Gorge figurája jeleníti meg, az élő oldalon is (a modell a repó része, lásd lent); ha nem töltődik be, egy stilizált robot. A Gorge animált modell, amely a mozgás irányához és az ugrásokhoz igazodik (futás négy irányba, ugrás, dupla ugrás, kiugrás, falról kiugrás, földetérés, ünneplés a célban). A szoba játékosai tömör Gorge-ként látszanak, finom, játékosszínű peremfénnyel és névcímkével (ütközés nincs), a szellemek (saját rekord, #1) áttetszőek, a játékos színével átszínezve. A rögzített szellemek ugrását a játék a függőleges mozgásból következteti ki, ezért a felszállást kb. 0,3 mp késéssel veszi észre (a 35 cm-ig terjedő lépcsőfokokat nem nézi ugrásnak).

```bash
python pajzsugras/tools/ut2004_extract.py "E:\UnrealTournament2004"                          # minden: a Gorge, a pajzsfegyver és a hangok
python pajzsugras/tools/ut2004_extract.py "E:\UnrealTournament2004" --only model --tex 512   # csak a Gorge, kisebb (512-es) textúrákkal
python pajzsugras/tools/ut2004_extract.py "E:\UnrealTournament2004" --only weapon            # csak a pajzsfegyver (a Gorge-hoz és a hangokhoz nem nyúl)
python pajzsugras/tools/ut2004_extract.py "E:\UnrealTournament2004" --only sounds            # csak a hangok
python pajzsugras/tools/ut2004_extract.py "E:\UnrealTournament2004" --force                  # a meglévő hangfájlokat és bőr-PNG-ket (a pajzsfegyverét is) felülírja (alapból megtartja őket)
python pajzsugras/tools/ut2004_extract.py "E:\UnrealTournament2004" --no-git-check            # git nélküli másolatban is ír (lásd lent)
```

A szkript csak Pythont használ (külső csomag nélkül), a telepítést csak olvassa, és ide ír: `pajzsugras/local-models/gorge.glb` (a modell, 36 animáció és a két textúra, kb. 2,7 MB), mellette a két textúra szerkeszthető PNG-ként (`gorge-body.png`, `gorge-head.png`, lásd a következő részt), `pajzsugras/local-models/shieldgun-1st.glb`, `shieldgun-3rd.glb` és `shieldgun.png` (a pajzsfegyver, lásd lent), és `pajzsugras/local-sounds/` (a 12 hang és a `sounds.json`). A hangok mappája (`local-sounds/`) a `.gitignore`-ban van, ezek nem kerülnek a repóba és az élő oldalra. A `local-models/` hat fájlja (`gorge.glb`, a két bőr-PNG, `shieldgun-1st.glb`, `shieldgun-3rd.glb`, `shieldgun.png`) viszont 2026-10-18 óta a tulajdonos döntésére a repó része, és az élő oldalra is felkerül: a production build a `tools/model-assets.mjs` segítségével hash-elt nevű fájlokba csomagolja őket (a bőr-PNG-k a beágyazott textúrák helyére kerülnek, a geometria és az animációk bájtra azonosak maradnak), a fejlesztői szerver az eredeti fájlokat adja. A mappa többi fájlja (pl. a mentések) továbbra is ignorált. Ezek az Epic szerzői joggal védett anyagai. Ha a fájl hiányzik vagy hibás, marad a robot és a szintetizált hang (a böngésző konzolja legfeljebb egy 404-es kérést mutat). A szkript a fájlokat előbb egy ideiglenes fájlba írja, és csak a végén nevezi át (egy félbeszakadt írás nem hagy fél fájlt, és a régit sem rontja el); a már meglévő hangfájlt csak akkor tartja meg, ha teljes WAV (különben újra kinyeri), így a saját UT99-es hangjaid maradnak. Nem ír olyan mappába, amelyet a git nem hagyna figyelmen kívül (hibaüzenettel áll le; git nélküli másolatban a `--no-git-check` engedi). Sérült vagy félbevágott csomagnál a hibaüzenet megnevezi a fájlt. A szkriptben és a tesztjében nincs Epic-adat, csak a fájlformátum olvasásának szabályai. Ellenőrzés: `python -I pajzsugras/tools/test_ut2004_extract.py`; a valódi fájlokon is lefut, ha van telepítés (az `UT2004_DIR` környezeti változó vagy az `E:\UnrealTournament2004` mappa jelzi), különben csak a szintetikus esetek futnak.

A fejlesztői szerver (`npm run dev`, `npm run preview`) csak a saját gépednek adja ki a `local-models/`, a `local-sounds/` és a `local-maps/` mappát: a LAN-ról (`--host`) vagy Cloudflare alagútról (`*.trycloudflare.com`) érkező kérésre 403-at válaszol, így a hangokat és a más szerzőtől átalakított pályákat nem adja tovább (a modellek az élő oldalon nyilvánosak); az ilyen látogatónál a játék a robotot és a szintetizált hangokat használja. A saját gépeden a `http://localhost:5173/pajzsugras/` címet nyisd meg (a LAN-os címen keresztül sem a modell, sem a hangok nem jönnek). A szabályt a `tools/local-guard.mjs` tartalmazza, a `vite.config.ts` köti be, a tesztje a `test/local-guard-tests.mjs`.

### Saját bőr a Gorgének (újrafestés)

A kinyerő a Gorge két textúráját külön PNG fájlként is kiírja a `pajzsugras/local-models/` mappába: **`gorge-body.png`** (test) és **`gorge-head.png`** (fej), 1024×1024 képpont (a `--tex 512` kapcsolóval 512×512). Ez pontosan ugyanaz a kép, ami a `gorge.glb`-ben van, ugyanazzal a UV-kiosztással.

1. Nyisd meg a PNG-t bármelyik képszerkesztőben (Paint.NET, GIMP, Photoshop, Krita ...), fesd át, és mentsd **PNG-ként ugyanazon a néven** ugyanabba a mappába.
2. A méret és a kiosztás maradjon: a modell a textúrán ugyanazokat a helyeket használja, ezért a színeket, mintákat, matricákat szabadon módosíthatod, de a részeket ne told el. Más méret is működik (a UV arányos), legfeljebb 4096×4096 képpontig és 32 MB-ig; ennél nagyobb vagy hibás fájlt a játék figyelmen kívül hagy.
3. Töltsd újra az oldalt (F5): a játék a `gorge.glb` betöltése után megpróbálja letölteni a két PNG-t, és ha megvan, a `glb` beágyazott textúrája helyett azt használja (a testen és a fejen külön; elég az egyiket átfesteni). Ha egy PNG hiányzik, hibás, vagy a fejlesztői szerver HTML-t ad helyette, a `glb` saját textúrája marad, hibaüzenet nélkül. A saját figurád (külső nézet), a szoba játékosai és a szellemek is az új bőrt viselik (a szellemek a játékos színével átszínezve).
4. A kinyerő **soha nem írja felül** a már meglévő PNG-ket (a te munkád lehet), csak `--force`-szal: a `--only model --force` kapcsolókkal futtatva visszaállítja az eredetit. Egy PNG törlése után az újrafuttatás újra kiírja. Ha a meglévő fájl nem PNG, a szkript figyelmeztet, de nem nyúl hozzá.

A két PNG a repó része: az átfestett bőr a következő feltöltés után az élő oldalon is mindenkinél látszik (a build a beágyazott textúra helyére teszi). A fejlesztői szerver a LAN-ról és az alagútról nem adja ki őket (lásd fent).

### A UT2004 pajzsfegyver

A kinyerő a saját telepítésedből (`Animations\Weapons.ukx` és `Textures\WeaponSkins.utx`) a pajzsfegyvert is kiírja a `pajzsugras/local-models/` mappába:

| Fájl | Mi ez |
|---|---|
| `shieldgun-1st.glb` | az elsőszemélyű modell és a hét animációja: `Idle` (2,95 mp, ismétlődik), `Select` (0,45 mp, előveszi), `PutDown` (0,45 mp), `Charge` (0,98 mp, a töltés), `Charged` (1 mp, ismétlődik, a teljesen feltöltött fegyver), `Fire` (0,48 mp, a lökés), `Shield` (0,98 mp, a UT2004 másodlagos tüze; a játék nem használja), kb. 1,2 MB |
| `shieldgun-3rd.glb` | a harmadikszemélyű modell (a karakterek kezében), egy póz (`Still`), kb. 1,1 MB |
| `shieldgun.png` | az egyetlen textúrája (`ShieldTex0`, 1024×1024, a UT2004-ben DXT5) szerkeszthető PNG-ként, kb. 1 MB |

- **Első személyben** a játék a saját pajzskesztyűje helyett ezt használja, az élő oldalon is (kapcsoló nincs): a fegyver alapban az `Idle` ciklust játssza, töltés közben a `Charge` animációt úgy, hogy az a töltés mértékét követi (nem az órát), teljes töltésnél a `Charged` ciklust, a lökésnél (bal gomb elengedése) a `Fire` animációt, újraéledéskor és a pálya elején a `Select` animációt. A pajzsgömb, a torkolati villanás és a töltés fénye a modell torkolati csontjánál (`Bone_Flash`) jelenik meg, és a mozgás (lépés ringása, hirtelen irányváltás, ugrás, landolás, visszarúgás) is marad. A fegyver a kép jobb alsó részén áll, a UT2004-hez hasonlóan, a saját jelenetében rajzolódik, ezért falba sem lóg bele, és a látómező beállítása nem torzítja.
- **Harmadik személyben** (külső nézet, a szobatársak és a szellemek) a Gorge jobb kezében látszik a `shieldgun-3rd.glb`: a kéz csontjához (`Bone_weapon`) van kötve, a Gorge UT2004-es csatolási koordinátáival (`righthand`), úgy, hogy az `Idle_Rifle` és a futás pózában előre néz. A szellemek fegyvere is áttetsző, a játékos színével. A robotnak nem kap fegyvert (neki van sajátja).
- **Szerkeszthető textúra**: a `shieldgun.png` RGBA kép (az alfa csatorna a fényességi/csillogási maszk: ahol erős, a felület fényes, ahol nulla, matt; átlátszóságnak nem használja a játék). Nyisd meg bármelyik képszerkesztőben, fesd át, és mentsd **PNG-ként ugyanazon a néven**, **alfa csatornával** együtt (a méret és a kiosztás maradjon, lásd a Gorge bőrénél). F5 után a játék a PNG-t használja mindkét modellen (elsőszemélyben és a kézben is); hiányzó, hibás vagy a fejlesztői szerver HTML-jét adó fájlnál marad a `glb` saját textúrája. A kinyerő **soha nem írja felül** a meglévő `shieldgun.png`-t (`--force` nélkül), a Gorge bőreihez hasonlóan.
- **Az élő oldalon is**: a három fájl a repó része, a build csomagolja őket (lásd fent). Ha nem töltődnek be, az elsőszemélyű nézetben marad a beépített fegyver, a figurák kezében pedig nincs semmi.
- **Ellenőrzés a böngészőben**: `__pj.state().viewmodel` = `{ ut, state, clip, time, charge, active, hidden }` (`ut: true`, ha a UT2004 fegyver van használatban; `clip` az éppen játszott animáció), és `__pj.state().figures[].weapon` jelzi, hogy egy figura kezében ott a fegyver.

## Szoba (többjátékos)

Egy szobában legfeljebb 8 játékos fut ugyanazon a pályán. A játékosok áttetsző szellemként látják egymást (ha megvan a Gorge modell, tömör figuraként), nincs ütközés.

1. Főmenü, **SZOBA**, **ÚJ SZOBA**: egy 4 betűs kód jön létre, és egy meghívó link (`…/pajzsugras/#KÓD`) a másolás gombbal.
2. A haver megnyitja a linket (vagy beírja a kódot) és belép. A szoba létrehozója a házigazda; aki később csatlakozik, nem veszi át a szerepet. Ha a házigazda kilép, a futam résztvevői közül a legkisebb azonosítójú folytatja.
3. Amíg a futam nem indul, mindenki szabadon gyakorolhat. A házigazda választ pályát és indít. Aki futam közben érkezik, nézőként vár, és a következő bemelegítésnél kerül a listára.
4. Visszaszámlálás, mindenki a rajthoz kerül, élő állás az ellenőrzőpontok alapján.
5. A futam akkor ér véget, ha mindenki célba ért, vagy az első cél után 60 másodperccel. Pontok: 10–8–6–5–4–3–2–1, a szoba összesítése a munkamenet végéig gyűlik.

**Ismert hiba (prototípus):** ritkán, lassú kapcsolatnál vagy ha ketten egyszerre lépnek be egy üres szobába, két házigazda alakulhat ki, és ha az üzeneteik keresztezik egymást, mindkettő átadhatja a szerepet a másiknak. Ilyenkor senki nem tud futamot indítani, amíg egyikük ki nem lép és vissza nem jön. Egy rosszindulatú játékos egy hamis üzenettel átveheti a házigazda szerepét. A tervezett javítás: a létrehozó marad a házigazda, a belépő sosem nevezi ki magát, helyette egy „Átveszem a szobát” gomb.

Az oldalt **HTTPS-en** (vagy localhoston) kell megnyitni, különben a szoba nem tud kapcsolódni. A hálózati beállítás ugyanaz, mint a többi játéknál: lásd a gyökér [README.md](../README.md) „Játék a haveroddal” részét.

## Ranglista (globális)

A **RANGLISTA** pályánként a legjobb 50 időt mutatja, a sajátod helyezésével. Szerver nincs: minden böngésző egyszer generál egy kulcsot (a böngészőben marad), és minden **új saját rekordot** aláírt Nostr eseményként tesz közzé néhány nyilvános reléen. A lista ugyanezekről a relékről töltődik be.

- A **nevek és idők nyilvánosak**, aki a relét nézi, látja őket.
- Az esemény a pálya ujjlenyomatához kötött, ezért ha egy pályát átterveznek, a régi idők eltűnnek.
- Értelmetlenül gyors időket a program eldob (a szerzői idő fele alatt nincs rekord, és a szobában sem számít a célba érkezés; szerzői idő nélküli pályán az alsó határ fix 3 mp).
- Ha a relék nem érhetők el, a játék ezt kiírja, a helyi rekordok attól még mentődnek.

## Pályaszerkesztő

A főmenü **Szerkesztő** pontja a saját pályáid listáját nyitja (új pálya, megnyitás, átnevezés, exportálás, törlés, importálás). Az **F2** ugyanide visz a menüből; egy beépített pálya közben az utoljára szerkesztett pályát nyitja meg (vagy újat kezd), a saját pályádon játszva pedig éppen azt a pályát. Szobában nem elérhető. Szabadon repülsz, a bal oldali palettáról építed a saját pályádat (padló, fal, kiugrófal, rámpa, oszlop, láva, lézer, „semmi” zóna, ugrópárna, ellenőrzőpont, cél, rajtpont, fény, dísz), a jobb oldali panelen pontos számokkal szerkeszted. Minden módosítás ugyanazzal a pályaépítővel épül újra, mint a beépített pályák (kb. 100 ms-mal a módosítás után), tehát amit látsz, azon futsz is.

| Billentyű | Mit csinál |
|---|---|
| Jobb gomb nyomva | körbenézés (az egér befogódik; ha a böngésző nem engedi, húzással is megy) |
| W A S D, Szóköz / E, Q / C | repülés, fel, le (Shift: 3× gyorsabb, görgő: sebesség) |
| Shift + görgő | lerakás előtt a szellem emelése / süllyesztése (így a levegőbe is rakhatsz); kijelölő eszközzel a kijelölt elem fel / le |
| Bal gomb | lerak (az eszközzel) vagy kijelöl; a kijelölt elemet húzva mozgatod |
| Shift + kattintás | az elemet hozzáadja a kijelöléshez vagy elveszi belőle |
| Húzás üres helyen | kijelölő keret: azok az elemek jelölődnek ki, amelyek egészükben a keretben vannak (a rajtpont, a párna és a fény a pontjukkal), így az alattuk lévő nagy padlót nem viszi; Shift-tel a meglévő kijelölést bővíti |
| Ctrl+A | mindent kijelöl (a rajtpontot is) |
| Csoport (több kijelölt elem) | húzva együtt mozog (egy lépés a visszavonásban), R forgatja a csoport közepe körül, Ctrl+D másolja, Del törli (a rajtpontot nem), a nyilak mozgatják; átméretezni nem lehet |
| Méretező nyilak | egy kijelölt elem lapjain színes nyilak: húzva a lap mozog, a szemközti marad; rácshoz és a szomszédos elemek széleihez igazodik |
| 1 – 0 | eszköz: padló, fal, kiugrófal, rámpa, oszlop, láva, lézer, ugrópárna, ellenőrzőpont, cél (a többi a palettán) |
| V / Esc | kijelölő eszköz (Esc: előbb a függő párna-cél, aztán a kijelölés szűnik) |
| K | a rajtpont oda, ahová célzol, a kamera irányával |
| Nyilak, PgUp / PgDn | a kijelölt elem mozgatása 0,5 m-rel (G: 0,1 m); Shift + ugyanezek: átméretezés |
| R, Ctrl+D, Del | forgatás 90°-kal, másolás, törlés |
| Ctrl+Z, Ctrl+Y | visszavonás, újra |
| Ctrl+S | mentés most (magától is ment) |
| T vagy F2 | **próba a kamerától**: ott indulsz, ahol a kamera áll; gyakorló futás, a cél az ellenőrzőpontok nélkül is számít, R és leesés után a kamera helyére térsz vissza |
| Enter | próba a rajtpontról, teljes szabályokkal |
| F2 / Esc próba közben | vissza a szerkesztőbe, pontosan ugyanoda |
| H, Tab | súgó (Esc bezárja), panelek elrejtése |

Az új és a húzott elem a kurzor alatti elem és a szomszédai széleihez tapad: ha valamelyik éle elég közel van, oda ugrik (egy új elem a méretének kb. harmadáig, legalább egy rácslépésről és legfeljebb 2 m-ről; húzásnál és a méretező nyilaknál gyengébben, legfeljebb 1 m-ről), különben a rácshoz igazodik, amely az alatta lévő elem sarkából indul. Falra téve az elem a talajon áll (nem süllyed az alatta lévő padlóba), kivéve ha a Shift + görgővel szándékosan emelted. Az ugrópárnánál az első kattintás a párna, a második a cél. A díszek (láda, oszlop, szikla, kristály, jelzőfény, boltív) a paletta alsó csoportjában vannak. A jobb oldali panel alján mindig látszanak az ellenőrzések: hiányzó cél, a rajtpont alatt nincs padló, a rajtpont halálzónában vagy falban van, egy ellenőrzőpont visszaszületési pontja halálzónában vagy falban van. Az ég, a köd és a színek a szerkesztő egyetlen témájából (KIKÉPZÉS) jönnek; téma választó nincs. Próba közben nincs rekord, eredményképernyő és ranglista, csak a „CÉLBAN!” felirat.

### Mentés, export, import

- **Mentés**: a pálya magától mentődik, 1,5 másodperccel az utolsó módosítás után, próba előtt, kilépéskor és ha a lap rejtve lesz vagy bezáródik; **Ctrl+S** (vagy a Mentés gomb) azonnal ment. Az eddig módosítatlan új pálya nem mentődik, így nem marad üres pálya a listában. Ha az írás nem sikerül (megtelt a tárhely vagy a böngésző letiltotta), felirat és üzenet jelzi, és javasolja az exportálást; a pálya a lap bezárásáig így is megmarad a memóriában, a felső sáv addig „Nincs mentve!”-t mutat, amíg egy mentés nem sikerül, és a szerkesztő újranyitáskor is ezt a mentetlen változatot tartja meg.
- **Tárolás**: a `pajzsugras:` localStorage kulcsokban: `ed:index` (a lista: azonosító, név, módosítás ideje, elemszám), `ed:map:<azonosító>` (a pálya JSON-ban), `ed:last` (az utoljára szerkesztett), `ed:pb:<azonosító>` (a pálya saját rekordja). Legfeljebb 40 saját pálya fér el, egyenként legfeljebb 1 MB (2000 elem kb. 200 kB); egy pályán legfeljebb 2000 elem lehet, és az ütközési rácsa (a tömbök, rámpák, oszlopok által érintett 8 m-es cellák) legfeljebb 1 millió cella (nyolc 400 m-es kocka már sok); a szerkesztő a határt átlépő lerakást vagy átméretezést, az importálás az ilyen fájlt elutasítja. Az index (`ed:index`) soraiban az ellenőrzőpontok száma, a cél megléte és a pálya hash-e is ott van, hogy a JÁTÉK lista ne építse fel minden mentett pályát; az import és az átnevezés nem írja át az `ed:last`-ot.
- **Exportálás**: az **Exportálás** gomb (a szerkesztőben) vagy a listán a pálya sora .json fájlként letölti a pályát (`pajzsugras-<név>.json`). **Importálás**: a lista tetején, fájlválasztóval; a program ellenőrzi a fájlt, magyar hibaüzenetet ad, ha nem pályafájl (nem JSON, ismeretlen formátum, túl nagy), a hibás elemeket kitisztítja. Ha az azonosító már foglalt, másolat készül új azonosítóval, a meglévő pályát soha nem írja felül.

### Játék a saját pályáddal

A **JÁTÉK** képernyőn a beépített pályák alatt a **Saját pályák** között minden mentett pálya ott van: **Játék**, **Szerkesztés**, **Törlés** (megerősítéssel). Cél nélkül a Játék gomb le van tiltva („Hiányzik a cél”). A saját pályán teljes szabályok vannak (az ellenőrzőpontok sorban, a cél csak utánuk számít), de csak helyi rekord (`ed:pb:<azonosító>`, szellemmel és részidőkkel, a pálya módosításakor eltűnik): nincs érem, nincs globális #1, nincs elküldött idő és nincs „következő pálya”. A beépített pályák rekordjait ez soha nem érinti. Új szoba a beépített pályán indul, nem a sajátodon.

### UT2004 pálya átalakítása (csak helyben)

Egy UT2004-es pálya (`.ut2`), amely egyszerű doboz alakú ecsetekből épül, átalakítható szerkesztő-pályafájllá, és a szerkesztőben megnyitható, játszható:

```bash
python -I pajzsugras/tools/ut2004_map.py "C:\Users\Te\Downloads\DPM-HoppHopp-v35-r1.ut2"            # -> pajzsugras/local-maps/hopphopp.json
python -I pajzsugras/tools/ut2004_map.py "<pálya.ut2>" --name "Saját név"                      # más név a játékban (alapból a fájlnév az előtag és a -v35-r1 típusú végződés nélkül)
python -I pajzsugras/tools/ut2004_map.py "<pálya.ut2>" --out "<mappa>" --no-git-check          # más mappába, git nélküli másolatban is ír
```

- **Csak helyben marad.** Az eredmény a `pajzsugras/local-maps/` mappába kerül, amely a `.gitignore`-ban van, és a fejlesztői szerver is csak a saját gépednek adja ki (lásd fent). A pálya másik szerző munkája: soha nem kerülhet a repóba, a build-be, az élő oldalra, és másnak sem adható tovább a szerző engedélye nélkül. A szkript nem ír olyan mappába, amelyet a git nem hagyna figyelmen kívül (`--no-git-check` nélkül hibaüzenettel áll le). A `.ut2` fájlt csak olvassa (nem futtat belőle semmit); a letöltött fájlhoz ezért is kell a `python -I` és az elérési út argumentumként. Az `npm run add-map` elutasítja a `local-maps/` mappában lévő fájlt: más szerzőtől átalakított pályából nem lehet beépített pálya (az a repóba és az élő oldalra kerülne).
- **Betöltés**: ha a játék ezen a gépen fut (`localhost`, `127.0.0.1`, `[::1]` vagy `*.localhost` címen, pl. `npm run dev`), az átalakított pálya **magától megjelenik** a **Saját pályák** között: a JÁTÉK képernyőn a beépített kártyák alatt és a szerkesztő kezdőlapján is („Helyi pálya betöltve” üzenet jelzi). Az átalakító a `local-maps/index.json` fájlban tartja a pályák listáját; a játék induláskor beolvassa, és minden új vagy megváltozott fájlt egyszer importál (a böngésző a `pajzsugras:localmaps` kulcsban jegyzi meg, melyiket). Ha a pályát törlöd, nem tér vissza, amíg a fájl nem változik; ha újra átalakítod és más lett az eredmény, új másolatként, új azonosítóval jön be (a régit kézzel töröld). Ha a pályát korábban már kézzel importáltad, az első indításkor még egyszer bejön másolatként: a régit töröld. Az élő oldalon és minden más címen (LAN, alagút) nem történik semmi, mert ott a mappa nincs meg, vagy a szerver nem adja ki. A kézi út is működik: főmenü → **Szerkesztő** → **Importálás (.json)** → válaszd ki a `local-maps/<név>.json` fájlt (a már foglalt azonosító miatt **másolat** készül új azonosítóval; a régit a szerkesztő nem írja felül).
- **Mit alakít át**: az összeadó és kivonó (Add / Subtract) **tengelyirányú doboz ecseteket**, a pályát kitöltő „kőzettel” együtt (a CSG-sorrendet a Level szerint), a **PlayerStart**-ot rajtpontnak (hely és irány; a talpa a padlóra kerül) és az első **\*FinishVolume**-ot célnak. Az üres tér körül 1,28 m vastag kőzethéj marad. A méret: 50 UU = 1 m. A pálya a KIKÉPZÉS témát kapja, a textúrák nem kerülnek át: a rácsos textúra **Rács** anyag, a kicsi (legfeljebb 2,56 m-es) hozzáadott darabok **Díszcsík**, a többi hozzáadott tömb **Fém**, a kőzet **Fal** (magas) vagy **Padló** (lapos). Ellenőrzőpont nem készül.
- **Kihagyja, és kiírja** a darabokat, amelyeknek nincs megfelelője: statikus modellek, felvehető tárgyak és fegyvertartók, fények, rajtvolume-ok, effektek és minden más ismeretlen objektum.
- **Elutasítja** (a hibaüzenet megnevezi az objektumot), ha az átalakítás nem hasonlítana az eredetire: nem doboz alakú vagy elforgatott / átméretezett ecset, nem tömör lapok (NotSolid, Semisolid, Portal), mozgó elem (Mover), ugrópárna, teleport, TerrainInfo, BlockingVolume, vagy ha nincs PlayerStart. Korlát: a fájl legfeljebb 64 MB, a pálya legfeljebb 2000 tömb, és a szerkesztő ütközési rácsának határa is él.

Az átalakítás után érdemes végigjátszani a pályát, és a szerkesztő ellenőrzéseit (a jobb oldali panel alja) átnézni: az ecsetek egész UU-ra kerekítése és a tömbökbe vonása miatt apró eltérések lehetnek az eredetihez képest.

Hibakereséshez: `await __pj.editor.open()`, `__pj.editor.setCam([0, 8, 12], 0, -30)`, `__pj.editor.aim(0, 0)` + `await __pj.editor.click()` (`click({ shift: true })` több elemet jelöl ki, `boxSelect(a, b)` kijelölő keretet húz, `handles()` a méretező nyilak helyét adja, `drag(from, to)` húz), `await __pj.editor.exec('add', 'cp', { c: [0, 2, -10] })`, `await __pj.editor.test({ from: 'cam' })`, majd `__pj.advance(...)` mint bármely pályán; `__pj.editor.state()` és `.doc()` adja az állapotot. Mentés és fájlok: `__pj.editor.save()`, `.list()`, `.exportText()`, `.importText(szöveg)`, `.open(azonosító)`, `.remove(azonosító)`; egy mentett pályát játszani: `await __pj.loadCustom(azonosító)`, utána `__pj.advance(...)`. A részletes lista a `main.js` hibakereső szakaszában van.

## Fejlesztőknek

```bash
npm run test:pj            # mozgás- és ütközésvizsgálat, technika-mérések, a beépített pályák vizsgálata, alkalmazás-tesztek
npm run test:pj -- --map=uj-palya -v   # egy beépített pálya részletei
npm run test:pj -- --gate=kanyar -v    # csak a megadott nevű kombó kapuk (b.gate), a tiltó keresés minden családjának legjobb futásával
npm run test:pj -- --gate=S            # az Új pálya öt szakaszának kapui és az S1-S5 útvonal (test/uj-palya-gates.mjs)
npm run add-map -- fajl.json [azonosító]   # kiexportált szerkesztő-pálya beépítése (lásd a Pályák résznél)
npm run gen:pj-sounds                      # a saját hangok újragenerálása (assets/sounds/), lásd a Hangok résznél
```

**Kombó kapuk** (`b.gate` a `sim/builder.js`-ben): egy rés, amit csak technikák kombinációja old meg. A teszt kétszer bizonyítja: (1) a megoldás (bot-lépések) célba ér, pontosan és „sloppy” (zajos, késő) futással is; (2) kb. 1100–2200 egyetlen technikás futás (ugrás, dupla ugrás, kiugrás, kiugró ugrás, átlós ugrás, falról kiugrás, pajzsugrás, fali lökés) nem érhet célba, és nem is közelítheti meg a célt 0,6 m-nél jobban. A futások 9 nekifutási irányból (a pajzsugrásé 13-ból) és 3 oldalirányú eltolásból indulnak, a szélen vagy a falnál, illetve egy lézerfüggöny előtt a legkésőbbi pillanatban (és 2 m-rel előtte is) ugranak, és több változatban: a dupla ugrás és a falról kiugrás után is (apex, késő), a pajzsugrás 0–100% töltéssel, 4 dőlésszöggel, az ugrás és a lökés közti ±10 tickes eltéréssel (a kettő összeadódik), a nekifutás irányába vagy a céllal ellentétesen célozva, néhány tickkel a perem előtt is. A legközelebbi futások paramétereit (irány, eltolás, időzítés, töltés, dőlésszög, kormányzás) a teszt még finomítja is. A keresés csak akkor érvényes, ha a technika tényleg megtörtént (az események alapján: ugrás, kiugrás, falról kiugrás, dupla ugrás, találó lökés), a futások legalább 25%-ában; a falat igénylő két családnál (falról kiugrás, fali lökés) legalább a felszállás kell. A kapuk tesztadatok (nem részei a pálya ujjlenyomatának), a pálya minden kapuja előtt ellenőrzőpont áll.

A böngészőben a `window.__pj` hibakereső felület használható (akkor is, ha a böngészőablak rejtett, mert a requestAnimationFrame ilyenkor nem fut):

```js
await __pj.loadMap('uj-palya')            // pálya betöltése, kézi léptetés
__pj.setInput({ fwd: 1, jump: true })     // billentyűk (pitchDeg / yawDeg fokban)
__pj.advance(1.5)                         // 1,5 mp szimuláció és egy kép kirajzolása
__pj.teleport([0, 0, -20], 90)            // játékos áthelyezése
await __pj.runRoute('azonosító')          // a bizonyító útvonal lejátszása (csak hibakereséshez; a kiexportált pályáknak nincs útvonala)
__pj.state()                              // állapot: hely, sebesség, óra, ellenőrzőpont, rajzolási szám, figures (a többi futó: modell, lejátszott animáció, weapon), view, camera és viewmodel (a fegyver)
__pj.view('kulso')                        // külső nézet ('belso' vissza, argumentum nélkül vált); state().camera = { view, pos, dist, limit, want, hit, hidden, self }
__pj.app.figures.upsert('t', { name: 'T', color: 0xff8a2a, pos: [0, 0, -5], yaw: 0, flags: 1, ghost: true, solid: true })   // próbafigura
await __pj.quality('magas')               // grafika szint
__pj.screen('results')                    // képernyők: menu, play, settings, controls, pause, results
```

Felépítés:

```
sim/        a szimuláció (nincs benne three, DOM, Date): ütközés, mozgás, pajzs, pályaépítő (builder.js), bizonyító bot
maps/       a beépített pályák: szerkesztő-exportok (sima JSON, uj-palya.js ...), index.js a lista (npm run add-map tölti)
render/     three.js: textúrák, pálya, ég, díszletek, figurák (figures.js; gorge.js a helyi Gorge modell és a bőr-PNG-k, gorge-anim.js az animáció-választás), pajzsfegyver
            (viewmodel.js az elsőszemélyű; gauntlet.js + hardkit.js + armour-mats.js a saját pajzskesztyű; vitrin.js a bemutatója;
            shieldgun.js a helyi UT2004 pajzsfegyver: betöltés, animáció, a Gorge kezébe kötés, csak dinamikus importtal és a ut-gun.js jegyzékén át), effektek,
            chasecam.js (a külső nézet kamerája: tiszta matek, az ütközési világgal)
tools/      add-map.mjs: szerkesztő-export beépítése pályának; ut2004_extract.py: a Gorge, a pajzsfegyver és a hangok kinyerése a saját UT2004 telepítésből (csak helyben), test_ut2004_extract.py a tesztje; ut2004_map.py: egy UT2004 pálya (.ut2) átalakítása szerkesztő-pályafájllá (csak helyben)
main.js     indítás, 120 Hz-es ciklus, a futás menete, az `app` felület a szoba és a ranglista számára
ui.js hud.js input.js audio.js store.js    menük, HUD, bemenet, hang, mentés
local-ut.js ut-local-sounds.js              a helyi UT2004-fájlok feltétele (csak fejlesztői build, csak ezen a gépen) és a helyi hangok betöltője
race.js leaderboard.js                      szoba és ranglista
editor/     a pályaszerkesztő: model.js (dokumentum, előzmények), convert.js (dokumentum -> builder), themes.js (az egyetlen téma: KIKÉPZÉS), pick.js (célzás, rács),
            library.js (a mentett pályák: lista, import, export, átnevezés, rekordok), local-maps.js (a `local-maps/` átalakított pályái magukat importálják, csak helyben), help.js (a billentyűk listája)
            tiszta modulok, node-ban tesztelve; editor.js (vezérlő, mentés), gizmos.js (segédmodellek), panel.js + editor.css (felület)
test/       a node-os tesztek
```

Új beépített pálya: a szerkesztőben építsd meg, exportáld, és `npm run add-map -- fajl.json` (lásd a Pályák résznél). Kézzel írt pályát (a pályaépítő nyelv leírása a `sim/builder.js` fejlécében, a bizonyító bot lépései a `sim/bot.js` fejlécében) csak a tesztek készítenek: `test/synth.mjs`, `test/probes.js`.
