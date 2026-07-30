// Icon catalog — categorised emoji with search tags.
// Each icon: [emoji, 'space separated search tags']

export const ICON_CATEGORIES = [
  {
    id: 'dev', name: 'Dev & Tech', icon: '💻',
    icons: [
      ['💻', 'laptop code programming dev'],
      ['🖥️', 'desktop computer monitor screen'],
      ['📱', 'phone mobile app smartphone'],
      ['⌨️', 'keyboard typing'],
      ['🖱️', 'mouse click'],
      ['💾', 'save disk floppy storage dane'],
      ['📀', 'dvd disc cd'],
      ['🚀', 'rocket launch deploy startup start'],
      ['⚡', 'lightning fast performance energy'],
      ['🔧', 'wrench tool fix repair'],
      ['🛠️', 'tools hammer wrench build'],
      ['⚙️', 'gear settings config'],
      ['🔩', 'nut bolt screw'],
      ['🌐', 'globe web internet www network'],
      ['📡', 'satellite antenna signal network'],
      ['🔌', 'plug api integration'],
      ['🔋', 'battery power energy'],
      ['🤖', 'robot ai bot automation'],
      ['🧠', 'brain ai intelligence ml'],
      ['🧪', 'test lab experiment testy'],
      ['🧬', 'dna genetics biotech'],
      ['🔬', 'microscope research science'],
      ['📊', 'chart data analytics stats dane'],
      ['🎮', 'game gaming controller gra pad'],
      ['🕹️', 'joystick arcade game gra automat'],
      ['📁', 'folder files directory project'],
      ['🗄️', 'cabinet database storage'],
      ['🐛', 'bug debug error insect'],
      ['🕸️', 'web spider scraping'],
      ['🖨️', 'printer print'],
      ['💿', 'cd disc software'],
      ['🧮', 'abacus calculation compute'],
      ['📟', 'pager device beeper pager'],
      ['🔭', 'telescope observe astronomy'],
    ]
  },
  {
    id: 'business', name: 'Business', icon: '💼',
    icons: [
      ['💼', 'briefcase work business office'],
      ['🏢', 'office building company'],
      ['🏭', 'factory industry production'],
      ['🏪', 'store shop'],
      ['🏬', 'department store mall centrum'],
      ['📋', 'clipboard tasks list checklist'],
      ['📑', 'documents pages tabs'],
      ['📄', 'document page file'],
      ['📃', 'page curl document'],
      ['🗂️', 'organizer dividers index segregator'],
      ['📌', 'pin pinned important'],
      ['📎', 'paperclip attachment'],
      ['🏷️', 'tag label price'],
      ['📈', 'growth chart up trend trend'],
      ['📉', 'decline chart down loss strata'],
      ['📅', 'calendar date schedule data harmonogram'],
      ['🗓️', 'calendar planner schedule planer'],
      ['⏰', 'alarm clock time reminder'],
      ['⏱️', 'stopwatch timer speed stoper'],
      ['🕐', 'clock time hour'],
      ['⌛', 'hourglass time deadline termin'],
      ['🤝', 'handshake deal partnership'],
      ['👔', 'tie formal business'],
      ['🏆', 'trophy winner success award'],
      ['🎖️', 'medal award honor medal'],
      ['🥇', 'gold medal first winner medal'],
      ['📇', 'card index contacts rolodex'],
      ['🖊️', 'pen signature contract'],
      ['💡', 'idea lightbulb innovation'],
      ['🚧', 'construction wip barrier w'],
      ['🏗️', 'crane construction building'],
    ]
  },
  {
    id: 'finance', name: 'Finance', icon: '💰',
    icons: [
      ['💰', 'money bag cash wealth kasa'],
      ['💵', 'dollar bill cash money'],
      ['💶', 'euro bill cash euro'],
      ['💷', 'pound bill cash funt'],
      ['💴', 'yen bill cash'],
      ['💸', 'money wings spending expenses'],
      ['💳', 'credit card payment'],
      ['🪙', 'coin gold currency'],
      ['🏦', 'bank finance institution bank'],
      ['🏧', 'atm cash machine'],
      ['📊', 'chart portfolio stats'],
      ['📈', 'stocks growth invest'],
      ['📉', 'stocks loss crash'],
      ['💹', 'market chart yen exchange'],
      ['🧾', 'receipt invoice bill paragon'],
      ['⚖️', 'scales balance law justice'],
      ['🏛️', 'bank government institution classical bank'],
      ['💎', 'diamond gem value premium'],
      ['👛', 'purse wallet'],
      ['🎰', 'slot machine gamble casino automat hazard'],
      ['🎲', 'dice gamble risk hazard'],
      ['₿', 'bitcoin crypto currency'],
      ['🔐', 'vault secure savings'],
      ['🐷', 'piggy bank savings'],
      ['💲', 'dollar sign price'],
    ]
  },
  {
    id: 'creative', name: 'Creative', icon: '🎨',
    icons: [
      ['🎨', 'art palette design paint'],
      ['🖌️', 'brush paint art'],
      ['🖍️', 'crayon draw color'],
      ['✏️', 'pencil write draw sketch'],
      ['📝', 'memo notes writing notes'],
      ['📐', 'ruler triangle design measure'],
      ['📏', 'ruler measure straight'],
      ['🎵', 'music note song'],
      ['🎶', 'music notes melody melodia'],
      ['🎹', 'piano keyboard music pianino'],
      ['🎸', 'guitar rock music rock'],
      ['🥁', 'drums percussion music'],
      ['🎺', 'trumpet brass jazz jazz'],
      ['🎻', 'violin classical music'],
      ['🎤', 'microphone sing podcast'],
      ['🎧', 'headphones audio music'],
      ['📻', 'radio broadcast audio radio'],
      ['🎬', 'movie film clapper video kino film'],
      ['🎥', 'camera video film film'],
      ['📸', 'camera photo picture'],
      ['📷', 'camera photography'],
      ['🎭', 'theater drama masks'],
      ['🎪', 'circus tent show'],
      ['🩰', 'ballet dance shoes'],
      ['🎼', 'sheet music score'],
      ['🧵', 'thread sewing craft'],
      ['🧶', 'yarn knitting craft'],
      ['📚', 'books library reading'],
      ['📖', 'book open reading'],
      ['🖼️', 'picture frame art painting rama'],
    ]
  },
  {
    id: 'social', name: 'Social', icon: '💬',
    icons: [
      ['💬', 'chat message talk'],
      ['🗨️', 'speech bubble comment'],
      ['💭', 'thought bubble thinking'],
      ['📧', 'email mail message'],
      ['✉️', 'envelope letter mail list'],
      ['📨', 'incoming mail message'],
      ['📮', 'mailbox post'],
      ['📣', 'megaphone announce marketing'],
      ['📢', 'loudspeaker announcement'],
      ['🔔', 'bell notification alert alert'],
      ['👥', 'people group team users'],
      ['👤', 'person user profile'],
      ['🗣️', 'speaking talk voice'],
      ['📞', 'phone call'],
      ['☎️', 'telephone call'],
      ['📲', 'mobile phone message'],
      ['🤳', 'selfie photo social selfie'],
      ['📰', 'newspaper news press'],
      ['🗞️', 'news rolled paper'],
      ['📺', 'tv television media media'],
      ['🎙️', 'studio microphone podcast studio'],
      ['💌', 'love letter message list'],
      ['🫂', 'hug people support'],
      ['👋', 'wave hello hi'],
      ['👍', 'thumbs up like ok'],
      ['🙏', 'thanks pray please'],
    ]
  },
  {
    id: 'sport', name: 'Sport', icon: '⚽',
    icons: [
      ['⚽', 'soccer football ball'],
      ['🏀', 'basketball ball'],
      ['🏈', 'american football'],
      ['⚾', 'baseball ball'],
      ['🎾', 'tennis ball racket'],
      ['🏐', 'volleyball ball'],
      ['🏓', 'ping pong table tennis pingpong'],
      ['🏸', 'badminton racket badminton'],
      ['🥅', 'goal net'],
      ['🎯', 'target dart goal bullseye cel'],
      ['🏒', 'hockey stick'],
      ['🏑', 'field hockey na'],
      ['🥍', 'lacrosse stick lacrosse'],
      ['🏏', 'cricket bat'],
      ['⛳', 'golf flag hole golf'],
      ['🏋️', 'weightlifting gym strength'],
      ['🤸', 'gymnastics cartwheel'],
      ['🤾', 'handball throw'],
      ['🧗', 'climbing wall'],
      ['🚴', 'cycling bike rower'],
      ['🚵', 'mountain bike mtb rower'],
      ['🏊', 'swimming pool'],
      ['🤽', 'water polo'],
      ['🚣', 'rowing boat'],
      ['🏄', 'surfing wave surfing'],
      ['⛷️', 'skiing snow'],
      ['🏂', 'snowboard snow snowboard'],
      ['⛸️', 'ice skating'],
      ['🥊', 'boxing gloves fight'],
      ['🥋', 'martial arts karate judo kimono'],
      ['🤺', 'fencing sword'],
      ['🏹', 'archery bow arrow'],
      ['🎳', 'bowling pins'],
      ['🏃', 'running run jogging'],
      ['🧘', 'yoga meditation'],
      ['🏇', 'horse racing'],
      ['🛹', 'skateboard'],
      ['🛼', 'roller skates'],
    ]
  },
  {
    id: 'health', name: 'Health', icon: '❤️',
    icons: [
      ['❤️', 'heart love health'],
      ['💪', 'muscle strength fitness'],
      ['🩺', 'stethoscope doctor medical'],
      ['💊', 'pill medicine drug lek'],
      ['💉', 'syringe injection vaccine'],
      ['🩹', 'bandage plaster wound plaster rana'],
      ['🏥', 'hospital clinic medical'],
      ['🚑', 'ambulance emergency'],
      ['🦷', 'tooth dentist'],
      ['🦴', 'bone skeleton'],
      ['👁️', 'eye vision watch'],
      ['🫀', 'heart organ cardio organ'],
      ['🫁', 'lungs breathing'],
      ['🧬', 'dna genes'],
      ['🩻', 'xray scan'],
      ['🌡️', 'thermometer fever temperature'],
      ['🧘', 'meditation yoga calm'],
      ['🧖', 'sauna spa wellness spa'],
      ['💆', 'massage relax'],
      ['😴', 'sleep rest sen'],
      ['🛌', 'bed sleeping sen'],
      ['🍎', 'apple healthy diet'],
      ['🥦', 'broccoli vegetables healthy'],
      ['🥗', 'salad diet healthy'],
      ['🚭', 'no smoking'],
      ['🧴', 'lotion skincare balsam'],
      ['🧠', 'mental health mind'],
      ['⚕️', 'medical symbol medicine symbol'],
    ]
  },
  {
    id: 'home', name: 'Home & Life', icon: '🏠',
    icons: [
      ['🏠', 'house home dom'],
      ['🏡', 'house garden home dom'],
      ['🏘️', 'houses neighborhood domy'],
      ['🛋️', 'sofa couch living room sofa salon'],
      ['🛏️', 'bed bedroom'],
      ['🚿', 'shower bathroom'],
      ['🛁', 'bathtub bath'],
      ['🚪', 'door entrance'],
      ['🪟', 'window'],
      ['🔨', 'hammer diy repair'],
      ['🪚', 'saw carpentry wood'],
      ['🪛', 'screwdriver diy'],
      ['🧹', 'broom cleaning'],
      ['🧺', 'laundry basket'],
      ['🧼', 'soap cleaning wash'],
      ['🪴', 'plant pot home dom'],
      ['🛒', 'shopping cart groceries'],
      ['🛍️', 'shopping bags'],
      ['🎁', 'gift present'],
      ['👶', 'baby child kids'],
      ['🧸', 'teddy bear toy kids'],
      ['🐕', 'dog pet'],
      ['🐈', 'cat pet'],
      ['👕', 'shirt clothes fashion'],
      ['👗', 'dress fashion'],
      ['👟', 'sneaker shoes'],
      ['💍', 'ring wedding jewelry'],
      ['🔑', 'key house access dom'],
      ['🕯️', 'candle light'],
      ['🧯', 'fire extinguisher safety'],
    ]
  },
  {
    id: 'travel', name: 'Travel', icon: '✈️',
    icons: [
      ['✈️', 'plane flight travel lot'],
      ['🛫', 'takeoff departure start'],
      ['🚗', 'car auto drive auto'],
      ['🏎️', 'race car fast racing'],
      ['🚕', 'taxi cab'],
      ['🚌', 'bus transport autobus transport'],
      ['🚚', 'truck delivery'],
      ['🚂', 'train locomotive'],
      ['🚇', 'metro subway metro'],
      ['🚲', 'bicycle bike rower'],
      ['🛵', 'scooter moped'],
      ['🏍️', 'motorcycle motor'],
      ['🛞', 'wheel tire'],
      ['⛵', 'sailboat sailing'],
      ['🚢', 'ship cruise'],
      ['⚓', 'anchor port port'],
      ['🚁', 'helicopter'],
      ['🗺️', 'map travel navigation'],
      ['🧭', 'compass direction'],
      ['🧳', 'luggage suitcase'],
      ['🎒', 'backpack hiking'],
      ['🏖️', 'beach vacation'],
      ['🏝️', 'island tropical'],
      ['⛰️', 'mountain hiking'],
      ['🏔️', 'snowy mountain'],
      ['🏕️', 'camping tent'],
      ['🗼', 'tower landmark'],
      ['🗽', 'statue liberty new york'],
      ['🏰', 'castle'],
      ['⛩️', 'shrine japan torii'],
      ['🛰️', 'satellite space'],
      ['🚀', 'rocket space'],
    ]
  },
  {
    id: 'food', name: 'Food', icon: '🍕',
    icons: [
      ['🍕', 'pizza italian pizza'],
      ['🍔', 'burger hamburger fastfood'],
      ['🌮', 'taco mexican'],
      ['🍣', 'sushi japanese'],
      ['🍜', 'ramen noodles soup'],
      ['🍝', 'pasta spaghetti'],
      ['🥪', 'sandwich'],
      ['🥗', 'salad healthy'],
      ['🍳', 'cooking egg breakfast'],
      ['🥘', 'paella pan dish'],
      ['🍲', 'stew pot soup'],
      ['🥩', 'steak meat'],
      ['🍗', 'chicken drumstick'],
      ['🥓', 'bacon'],
      ['🍞', 'bread bakery'],
      ['🥐', 'croissant bakery'],
      ['🥑', 'avocado'],
      ['🍅', 'tomato'],
      ['🥕', 'carrot'],
      ['🌽', 'corn'],
      ['🍇', 'grapes'],
      ['🍓', 'strawberry'],
      ['🍋', 'lemon'],
      ['🍉', 'watermelon'],
      ['🍰', 'cake dessert tort'],
      ['🧁', 'cupcake muffin'],
      ['🍦', 'ice cream'],
      ['🍫', 'chocolate'],
      ['🍪', 'cookie'],
      ['☕', 'coffee cafe'],
      ['🍵', 'tea green'],
      ['🍺', 'beer'],
      ['🍷', 'wine'],
      ['🍸', 'cocktail drink drink'],
      ['🥤', 'soda drink cup'],
    ]
  },
  {
    id: 'nature', name: 'Nature', icon: '🌍',
    icons: [
      ['🌍', 'earth world globe glob'],
      ['🌱', 'seedling plant growth eco'],
      ['🌿', 'herb leaf plant'],
      ['🍀', 'clover luck'],
      ['🌳', 'tree forest las'],
      ['🌲', 'evergreen pine tree'],
      ['🌴', 'palm tree tropical palma'],
      ['🌵', 'cactus desert'],
      ['🌸', 'blossom flower spring'],
      ['🌻', 'sunflower'],
      ['🌹', 'rose flower'],
      ['🌷', 'tulip flower'],
      ['☀️', 'sun sunny'],
      ['🌙', 'moon night'],
      ['⭐', 'star'],
      ['✨', 'sparkles magic'],
      ['☁️', 'cloud weather'],
      ['🌧️', 'rain weather'],
      ['❄️', 'snowflake winter'],
      ['🌈', 'rainbow'],
      ['🔥', 'fire hot flame trending'],
      ['💧', 'water drop'],
      ['🌊', 'wave ocean sea ocean'],
      ['🦊', 'fox animal lis'],
      ['🐺', 'wolf animal wilk'],
      ['🦁', 'lion animal lew'],
      ['🐻', 'bear animal'],
      ['🦅', 'eagle bird'],
      ['🦉', 'owl bird wisdom'],
      ['🐢', 'turtle slow'],
      ['🐝', 'bee honey'],
      ['🦋', 'butterfly'],
      ['🐛', 'caterpillar bug'],
      ['🐟', 'fish sea'],
      ['🐙', 'octopus sea'],
      ['🦄', 'unicorn magic'],
    ]
  },
  {
    id: 'misc', name: 'Symbols', icon: '⭐',
    icons: [
      ['📚', 'books education study'],
      ['🎓', 'graduation education degree studia'],
      ['🏫', 'school building'],
      ['🔭', 'telescope astronomy'],
      ['⚛️', 'atom physics science atom'],
      ['🧲', 'magnet physics magnes'],
      ['🔮', 'crystal ball future magic kula'],
      ['♟️', 'chess pawn strategy'],
      ['🧩', 'puzzle piece integration puzzle'],
      ['📦', 'package box delivery'],
      ['🗃️', 'card file box archive'],
      ['🔄', 'refresh sync loop'],
      ['♻️', 'recycle eco'],
      ['🔒', 'lock secure private'],
      ['🔓', 'unlock open'],
      ['🔐', 'locked key secure'],
      ['🛡️', 'shield protection security'],
      ['🗝️', 'old key access stary'],
      ['⚗️', 'alchemy chemistry'],
      ['🎉', 'party celebration confetti'],
      ['🎊', 'confetti celebration'],
      ['🎈', 'balloon party'],
      ['🎂', 'birthday cake tort'],
      ['🃏', 'joker card joker'],
      ['🀄', 'mahjong game gra'],
      ['❓', 'question help'],
      ['❗', 'exclamation important'],
      ['✅', 'check done success'],
      ['❌', 'cross error no'],
      ['⚠️', 'warning caution'],
      ['🚫', 'forbidden no'],
      ['💯', 'hundred perfect score'],
      ['🔟', 'ten number'],
      ['🆕', 'new'],
      ['🆓', 'free'],
      ['♾️', 'infinity'],
    ]
  },
];

// Flat list of all catalog icons (for lookups)
export const ALL_ICONS = ICON_CATEGORIES.flatMap(c => c.icons.map(([e]) => e));

let lastActiveTabId = null;

function findCategoryIdOf(icon) {
  if (!icon) return null;
  const cat = ICON_CATEGORIES.find(c => c.icons.some(([e]) => e === icon));
  return cat?.id || null;
}

function searchIcons(query) {
  const q = query.trim().toLowerCase();
  const results = [];
  const seen = new Set();
  for (const cat of ICON_CATEGORIES) {
    for (const [e, tags] of cat.icons) {
      if (seen.has(e)) continue;
      if (e === q || tags.includes(q)) {
        results.push(e);
        seen.add(e);
      }
    }
  }
  return results;
}

// Render a tabbed, searchable icon picker into container.
// Selected icon is kept in container.dataset.selectedIcon (survives tab switches
// and searches, unlike the .selected class which only exists on visible icons).
export function renderTabbedIconPicker(container, selectedIcon = '') {
  if (!container) return;

  container.classList.add('icon-picker-tabbed');
  container.classList.remove('icon-picker');
  container.dataset.selectedIcon = selectedIcon || '';

  let activeTabId = findCategoryIdOf(selectedIcon) || lastActiveTabId || ICON_CATEGORIES[0].id;

  container.innerHTML = `
    <input type="text" class="icon-search" placeholder="Search icons… (e.g. money, sport)">
    <div class="icon-tabs"></div>
    <div class="icon-grid icon-picker"></div>
  `;

  const searchInput = container.querySelector('.icon-search');
  const tabsEl = container.querySelector('.icon-tabs');
  const gridEl = container.querySelector('.icon-grid');

  const renderTabs = (disabled) => {
    tabsEl.innerHTML = ICON_CATEGORIES.map(c => `
      <button type="button" class="icon-tab ${!disabled && c.id === activeTabId ? 'active' : ''}"
              data-tab="${c.id}" title="${c.name}">${c.icon}</button>
    `).join('');
    tabsEl.querySelectorAll('.icon-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTabId = btn.dataset.tab;
        lastActiveTabId = activeTabId;
        searchInput.value = '';
        renderTabs(false);
        renderGrid();
      });
    });
  };

  const renderGrid = () => {
    const query = searchInput.value.trim();
    const icons = query
      ? searchIcons(query)
      : (ICON_CATEGORIES.find(c => c.id === activeTabId)?.icons.map(([e]) => e) || []);

    gridEl.innerHTML = icons.length > 0
      ? icons.map(icon => `
          <div class="icon-option ${icon === container.dataset.selectedIcon ? 'selected' : ''}" data-icon="${icon}">${icon}</div>
        `).join('')
      : '<div class="icon-search-empty">No icons found</div>';

    gridEl.querySelectorAll('.icon-option').forEach(opt => {
      opt.addEventListener('click', () => {
        gridEl.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        container.dataset.selectedIcon = opt.dataset.icon;
      });
    });
  };

  searchInput.addEventListener('input', () => {
    renderTabs(searchInput.value.trim().length > 0);
    renderGrid();
  });

  renderTabs(false);
  renderGrid();
}

// Read the current selection from a picker container
export function getPickedIcon(containerId) {
  return document.getElementById(containerId)?.dataset.selectedIcon || '';
}
