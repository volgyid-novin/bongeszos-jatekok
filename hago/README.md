# HÁGÓ

MOBA a böngészőben, képregényes cel-shading stílusban (a régi XIII című játék hangulatában): **2v2** (vagy 1v1) egy hegyi hágón. Egy ösvény vezet a két bázis között, rajta minionok, oldalt tornyok, a szurdokban pedig egy őr, akit érdemes legyőzni. Négy hős közül lehet választani, mindegyiknek 5 képessége, 1 végső képessége és 2 passzív képessége van.

Egyedül a gép ellen is lehet játszani (három nehézség), vagy legfeljebb 4 játékossal: az üres helyeken gép játszik. Játékszerver nincs: a böngészők közvetlenül kapcsolódnak egymáshoz (WebRTC, Trystero/Nostr), ugyanúgy, mint a többi játékban.

## Indítás

A projekt gyökérmappájából (`D:\izsi\lol`):

```bash
npm install
npm run dev
```

Utána nyisd meg: http://localhost:5173/hago/

## Játék barátokkal

Online: **https://volgyid-novin.github.io/bongeszos-jatekok/hago/**. Írd be a neved, válassz hőst, nyomj **ÚJ SZOBA**-t, és küldd el a meghívó linket. Aki megnyitja, annak a kód már be van írva, csak a **BELÉPÉS** gombot kell megnyomnia. A szobában bárki átülhet egy üres helyre (kék vagy piros csapat), a házigazda állítja be a módot (2v2 / 1v1) és a gépi játékosok nehézségét. Ha minden játékos **KÉSZ**, indul a meccs.

Saját gépről futtatva az oldalt **HTTPS-en** (vagy localhoston) kell megnyitni, különben a szoba nem tud kapcsolódni:

```bash
npm run build
npm run preview
```

```bash
npx cloudflared tunnel --url http://localhost:4173
```

A kiírt `https://….trycloudflare.com/hago/` linket nyisd meg (ne a localhostot).

## Irányítás

Egér és billentyűzet kell hozzá, telefonon nem játszható. Az irányítás a nagy MOBA-kéhoz hasonló.

| Mit | Hogyan |
|---|---|
| Mozgás | jobb klikk a földre (nyomva tartva a kurzort követi) |
| Támadás | jobb (vagy bal) klikk egy ellenségre |
| Támadó menet | **A**, majd klikk: útközben mindent megtámad |
| Megállás | **S** |
| Képességek | **Q W E D F**, végső: **R**. Nyomva tartva célzol (jelző a földön), felengedve indul. Jobb klikk közben: mégse |
| Gyors varázslás | a menüben bekapcsolható: a képesség lenyomásra indul, célzás nélkül |
| Visszatérés a bázisra | **B** (4 mp, sebzés vagy mozgás megszakítja) |
| Bolt / gyógyital | **P** / **1** |
| Kamera | a hősödet követi; **Y**: rögzítés ki-be (szabadon: képernyő széle, középső gombos húzás, minitérkép), **Szóköz**: vissza a hősre, görgő: zoom |
| Eredménytábla / menü | **Tab** (nyomva) / **Esc** |

## Szabályok

- **A cél:** rombold le az ellenfél kristályát (a bázisa közepén). Előtte le kell dönteni a 3 tornyát sorban: a külsőt, a belsőt és az őrtornyot. Amíg egy torony áll, a mögötte lévő nem sebezhető.
- **Minionok:** 15 mp-től 25 mp-enként jön egy hullám mindkét bázisból (3 kardos, 2 varázsló, minden 3. hullámban egy ágyú is). Az idő múlásával erősödnek, és a tornyokat egyre jobban sebzik, így a meccsek nem húzódnak a végtelenségig.
- **Tornyok:** előbb a minionokat lövik. Ha egy hős a torony közelében megsebez egy ellenséges hőst, a torony átvált rá. A hősre egymás után leadott lövések egyre erősebbek. Minionok nélkül a tornyok és a kristály 40%-kal kevesebb sebzést kapnak (hátsóajtó-védelem).
- **Az Őr:** a szurdokban 2:00-tól vár egy kőóriás (3 perccel a halála után újra megjelenik). Aki legyőzi, annak a csapata aranyat és tapasztalatot kap, a hősei pedig 2 percig **az Őr áldását**: +20% sebzés, a közelükben a minionok 50%-kal erősebben ütnek és 30%-kal kevesebb sebzést kapnak, a visszatérés gyorsabb. Az őr 8 mp-enként lecsap maga elé (piros kör jelzi), és ha túl messzire húzzák, visszamegy és felgyógyul.
- **Szintek:** a közeli minionok és hősök halála tapasztalatot ad (legfeljebb 13. szint). Az 1. szinten a **Q W E** és az első passzív képesség él, a 2. szinten nyílik a **D**, a 3.-on az **F**, a 4.-en a második passzív, az 5.-en a végső (**R**). Minden szint erősíti a hőst és a képességeit.
- **Arany és bolt:** 600 arannyal indulsz, 1:00-tól másodpercenként 2,4 jár, a minion utolsó ütése 15–45, egy hős leütése 250 (sorozatnál több), a segítség 125, egy torony az egész csapatnak 120–150. Vásárolni a bázison (vagy halottan) lehet: 7 alaptárgy és 8 egyedi képességű remekmű, legfeljebb 6 tárgy, plusz 3 gyógyital.
- **Bokrok és gyógyító ereklyék:** a bokorban álló egységet az ellenfél csak közelről látja. Az ösvény két oldalán egy-egy zöld kereszt gyógyít, 40 mp-enként újra megjelenik.
- **Kút:** a saját kút gyorsan gyógyít, az ellenséges kút lézere szétszed.
- **Újraéledés:** 4 + 2 × szint másodperc.

## A négy hős

| Hős | Szerep | Képességek |
|---|---|---|
| **GRANIT**, a Kőlovag | harcos | **P** Kőbőr (pajzs, ha 6 mp-ig nem sebzik), Földrengető (minden 3. ütés rengés) · **Q** Pajzsroham (roham, kábít) · **W** Földhasítás (hasadék, levegőbe dob) · **E** Kőpajzs (pajzs magára és a társára) · **D** Dübörgés (provokál) · **F** Forgószél (pörgés mozgás közben) · **R** Hegyomlás (ugrás, becsapódás, földrengés) |
| **PARÁZS**, a Lángszövő | varázsló | **P** Égés (a képességei felgyújtanak), Túlhevülés (minden 4. képesség erősebb és nagyobb) · **Q** Tűzgolyó · **W** Lángfal (lassít, a társakat gyorsítja) · **E** Lángugrás (ugrás robbanással) · **D** Izzó kör (késleltetett kábítás) · **F** Lángnyelv (tűzkúp) · **R** Meteor |
| **SÓLYOM**, a Vadász | lövész | **P** Feszített húr (minden 4. lövés kritikus és átüt), Lendület (képesség után gyorsabb támadás és futás) · **Q** Átütő nyíl · **W** Nyílzápor (lassít) · **E** Vetődés (a következő lövés erősebb) · **D** Medvecsapda (láthatatlan, gyökereztet) · **F** Sólyomroham (megjelöli a célpontot) · **R** Viharnyíl (átlövi a pályát; minél messzebbről, annál erősebb) |
| **ÁRNY**, az Orgyilkos | orgyilkos | **P** Árnyjel (a jelölt célpontra mért ütés felrobbantja a jelet), Kivégzés (hős leütése után újratöltődnek a képességei) · **Q** Pengedobás · **W** Füstbomba (láthatatlanság a füstben) · **E** Árnylépés (bárki mögé lép) · **D** Pengevihar (körbecsapás, gyógyít) · **F** Árnykép (hasonmás, ő maga eltűnik) · **R** Holdtánc (öt csapás, közben sebezhetetlen) |

A képességek fele célzott lövés (egyenes vonalban repül, el lehet ugrani előle), a többi kijelölt területre, egy célpontra vagy azonnal hat. A pontos számok a menüben és játék közben is ott vannak a képességek leírásában (az egeret az ikon fölé víve).

## A gép

A gépi hősök ugyanazokat a parancsokat adják ki, amiket egy játékos: vásárolnak, a minionjaik mögött haladnak, utolsó ütéssel aratnak, piszkálják az ellenfelet, ha jobbnak érzik az esélyeiket, beszállnak a harcba, kitérnek a lövések és a földre rajzolt jelzések elől, alacsony életerőnél visszavonulnak és hazateleportálnak, és ha az ellenfél halott vagy messze van, megtámadják az őrt vagy a tornyokat.

| Szint | Mit csinál |
|---|---|
| Könnyű | lassan reagál, pontatlanul céloz, ritkán tér ki, óvatosan támad |
| Normál | közepes reakció és célzás, a lövések harmadából kitér |
| Nehéz | gyors, pontos, a lövések kétharmadából kitér, bátrabban támad, a hasonmást is gyakran kiszúrja |

## Hogyan működik

- **Hálózat:** a házigazda (a legkisebb azonosítójú gép) futtatja a szimulációt másodpercenként 30 ütemben, és minden második ütemben elküldi a pillanatképet (helyzetek, életerők, állapotok) a közben történt eseményekkel (találatok, lövedékek, képességek). A többiek csak a parancsaikat küldik. Minden gép, a házigazda is, ugyanabból a pillanatképsorból rajzol: kicsit lemaradva, két pillanatkép között simítva, az eseményeket pedig a hozzájuk tartozó pillanatban játssza le. Ha egy játékos kilép, a hősét a gép viszi tovább; ha a házigazda lép ki, a meccs véget ér. A házigazda szimulációja akkor is fut, ha a lapja a háttérbe kerül.
- **Grafika (`toon.js`):** a felületek három fénysávot kapnak, az árnyékos részeken világtérbeli keresztsatírozással, festett ecsetvonásos textúrával. A talaj egyetlen, ecsetvonásokkal megfestett kép. A fekete kontúrokat utófeldolgozás rajzolja a mélység- és normálképből (sziluettek és élek). A ragyogó effektek a kontúrok után rajzolódnak, és maguk vetik össze a mélységüket a jelenettel. A tereptárgyak és a terep 16×16 m-es darabokból állnak, így a kamera és az árnyék csak azt rajzolja, amit lát. A torony vagy szikla mögé került hősök csapatszínű sziluettként átlátszanak.
- **Hangok (`audio.js`):** minden hang szintetizált (oszcillátorok és szűrt zaj), hangfájl nincs.

## Felépítés

```
hago/
  index.html   menük, szoba, HUD, bolt, stílus
  data.js      minden szám: hősök és képességeik, minionok, tornyok, az őr, tárgyak, arany és tapasztalat
  map.js       a pálya: járható terület (távolságmező), útvonal a szurdokba, bokrok, a díszlet magassága
  sim.js       a szimuláció: mozgás, harc, lövedékek, zónák, minionhullámok, tornyok, őr, halál, arany, pillanatkép
  skills.js    mit csinálnak a képességek és a passzívok
  ai.js        a gépi hősök
  world.js     a kirajzolt állapot: pillanatképek simítása, események időzítése
  toon.js      képregényes anyagok, festett textúrák, a kontúrozó utófeldolgozás
  models.js    hősök, minionok, tornyok, kristály, őr, díszletelemek alapformákból
  view.js      three.js jelenet: terep, díszlet, egységek animációja, kamera, kijelölés, portrék
  fx.js        lövedékek, robbanások, zónák, állapotjelek, célzásjelzők, hangok
  hud.js       életerőcsíkok, sebzésszámok, hangutánzó feliratok, képességsor, minitérkép, bolt, eredménytábla
  icons.js     a képességek és tárgyak ikonjai
  audio.js     szintetizált hangok
  net.js       P2P szoba (Trystero)
  main.js      menük, szoba, bemenet, játékhurok
```

A balansz a `data.js`-ben van. Fejlesztéshez a böngésző konzoljában ott a `hago` objektum: `hago.lab(hős, szint)` egy megállított tesztpályát indít (a hősöd középen, az ellenfél előtted áll), `hago.advance(mp)` előreléptet, `hago.frozen = false` újra elindítja az időt.
