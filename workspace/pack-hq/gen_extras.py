#!/usr/bin/env python3
"""Pre-generate spy avatars for future agent names."""

import os, sys, time
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(os.path.expanduser('~/claudeclaw/.env'))

from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ['GOOGLE_AI_STUDIO_KEY'])
OUT = Path(__file__).parent / 'avatars'
OUT.mkdir(exist_ok=True)

EXTRAS = {
    'bear': """Photorealistic CGI render of a grizzly bear as a KGB-era Soviet spy. Seated across a chess table in a dimly lit Moscow safe house, wearing a thick wool suit, fur-lined collar. Arms folded, calculating stare. A half-drunk glass of vodka on the table. Cold War psychological thriller vibes. Moody amber tungsten lighting, frost on the window behind. Hyper-detailed dense fur and fabric. No borders, full bleed. Square format, portrait framing.""",

    'hawk': """Photorealistic CGI render of a red-tailed hawk as an aerial surveillance operative. Perched on the edge of a satellite dish on a rooftop at sunrise, wearing a tactical vest over a black turtleneck, earpiece in. Binoculars around neck, sharp predator eyes scanning the city below. Top Gun meets CIA vibes. Golden morning light, urban sprawl stretching to the horizon. Hyper-detailed feathers and gear. No borders, full bleed. Square format, portrait framing.""",

    'cobra': """Photorealistic CGI render of a king cobra as a deadly assassin spy. Coiled upright in a Bangkok penthouse suite at night, wearing a tailored all-white suit, jacket open. A silenced pistol resting on the glass table beside a cocktail. Hypnotic golden eyes. Kill Bill meets James Bond vibes. Neon city lights through floor-to-ceiling windows. Hyper-detailed iridescent scales and fabric. No borders, full bleed. Square format, portrait framing.""",

    'eagle': """Photorealistic CGI render of a bald eagle as a CIA director. Standing behind a massive mahogany desk in a Washington DC office, wearing a dark navy double-breasted suit with American flag pin. Arms behind back, commanding posture. Framed presidential portraits and classified maps on the wall behind. The Dark Knight Harvey Dent power stance. Dramatic directional sunlight through venetian blinds. Hyper-detailed feathers. No borders, full bleed. Square format, portrait framing.""",

    'tiger': """Photorealistic CGI render of a Bengal tiger as an undercover operative in Mumbai. Standing in a crowded spice market, wearing a cream linen suit, open collar, sunglasses. One paw resting on a motorcycle handlebar, scanning the crowd. Bollywood spy thriller meets Bourne Identity vibes. Warm chaotic market lighting, colorful bokeh of market stalls. Hyper-detailed striped fur. No borders, full bleed. Square format, portrait framing.""",

    'shark': """Photorealistic CGI render of a great white shark as a maritime intelligence operative. Standing at the helm of a sleek black submarine conning tower at night, wearing a naval officer coat with rank insignia, no medals. Arms behind back, cutting through sea spray. The Hunt for Red October vibes. Dark ocean, moonlight glinting on waves. Hyper-detailed skin texture and uniform. No borders, full bleed. Square format, portrait framing.""",

    'crow': """Photorealistic CGI render of a crow as a master of disguise spy. Standing in a Paris street market in a long black coat and wide-brimmed hat, face partially obscured by shadow. Multiple fake passports fanning out in one hand. The Day of the Jackal vibes. Overcast grey Parisian light, out-of-focus Eiffel Tower in distance. Hyper-detailed iridescent black feathers. No borders, full bleed. Square format, portrait framing.""",

    'owl': """Photorealistic CGI render of a great horned owl as the head of a secret intelligence agency. Sitting at an enormous round table in a dark underground bunker, wearing a distinguished charcoal suit. Surrounded by maps and mission dossiers, wire-frame glasses low on the beak. M from James Bond energy. Single overhead light source, classified stamps visible on documents. Hyper-detailed feathers. No borders, full bleed. Square format, portrait framing.""",

    'cheetah': """Photorealistic CGI render of a cheetah as a high-speed extraction specialist. Mid-sprint across a dusty African airstrip toward an idling private jet, wearing a tactical jacket, duffel bag over shoulder, looking back at pursuers. Motion blur on legs, sharp face. Kingsman action sequence energy. Blazing sunset behind, dust trail. Hyper-detailed spotted fur. No borders, full bleed. Square format, portrait framing.""",

    'viper': """Photorealistic CGI render of a pit viper as a cold-blooded female assassin spy. Seated at a vanity mirror in a Vienna hotel room, wearing a sleek emerald cocktail dress, adjusting a poisoned ring. Reflection shows the target's hotel across the street. Atomic Blonde femme fatale vibes. Warm vanity bulb lighting, cold blue city glow from window. Hyper-detailed scales. No borders, full bleed. Square format, portrait framing.""",

    'wolverine': """Photorealistic CGI render of a wolverine as an off-the-books black ops operative. Emerging from dense Siberian forest at dusk, wearing a dark military jacket, breath visible in cold air. Jaw set, eyes hard. No gadgets, no backup. Lone Wolf McQuade meets Sicario vibes. Muted cool forest light, snowflakes beginning to fall. Hyper-detailed thick fur. No borders, full bleed. Square format, portrait framing.""",

    'raccoon': """Photorealistic CGI render of a raccoon as a master thief turned intelligence asset. Crouched on a museum skylight at midnight, wearing a slim black wetsuit, lock picks between fingers, studying the layout below through night-vision goggles. Ocean's Eleven heist energy. Deep blue moonlight, sparkling cityscape below. Hyper-detailed masked face fur. No borders, full bleed. Square format, portrait framing.""",

    'falcon': """Photorealistic CGI render of a peregrine falcon as a drone warfare specialist. Standing in a military ops trailer in the Nevada desert, wearing flight suit and headset, controlling a mission on multiple screens. Eyes locked on target. Eye in the Sky / Zero Dark Thirty vibes. Cool blue screen glow on face, red mission clock on wall. Hyper-detailed feathers. No borders, full bleed. Square format, portrait framing.""",

    'puma': """Photorealistic CGI render of a puma as a Latin American cartel intelligence infiltrator. Leaning against a hacienda wall in Cartagena at golden hour, wearing a linen guayabera shirt, arms crossed, watching the courtyard. Narcos meets No Country for Old Men vibes. Warm golden Colombian light, bougainvillea in background. Hyper-detailed tawny fur. No borders, full bleed. Square format, portrait framing.""",

    'boar': """Photorealistic CGI render of a wild boar as a veteran field operative who doesn't play by the rules. Sitting in a grimy Berlin dive bar, wearing a rumpled leather jacket, untouched beer in front of him, classified file on the table. Just back from a mission gone wrong. Tinker Tailor meets The Americans vibes. Low tungsten bar lighting, smoke in the air. Hyper-detailed bristled fur and tusks. No borders, full bleed. Square format, portrait framing.""",

    'gecko': """Photorealistic CGI render of a gecko as a surveillance and infiltration specialist. Clinging vertically to a glass skyscraper at night, peering through the boardroom window at a secret meeting inside, wearing a micro-thin black stealth suit. Impossible mission energy. Neon city reflected in the glass, vertiginous drop below. Hyper-detailed textured skin. No borders, full bleed. Square format, portrait framing.""",

    'elk': """Photorealistic CGI render of a bull elk as a Scandinavian intelligence officer. Standing on a snow-covered fjord dock at blue hour, wearing a grey wool peacoat and leather gloves, reading a decoded message. Calm, unhurried, impossibly stoic. Nordic noir vibes. Cold blue twilight, ice on the water, distant mountains. Hyper-detailed antlers and fur. No borders, full bleed. Square format, portrait framing.""",

    'hyena': """Photorealistic CGI render of a spotted hyena as a black market arms dealer turned informant. Sitting in the back of a Cairo hookah lounge, wearing a garish gold-trimmed suit, diamond rings, cigar in hand. Laughing at his own joke while a dossier slides across the table. Layer Cake meets Snatch underworld energy. Warm smoky amber lighting, ceiling fans. Hyper-detailed spotted fur. No borders, full bleed. Square format, portrait framing.""",

    'ram': """Photorealistic CGI render of a bighorn ram as a close protection / bodyguard operative. Standing at attention outside a UN conference room, wearing an all-black suit, earpiece, hands clasped. Immovable. Massive curved horns. Secret Service meets Man on Fire vibes. Clean white marble corridor, harsh fluorescent lighting. Hyper-detailed horn and wool texture. No borders, full bleed. Square format, portrait framing.""",

    'weasel': """Photorealistic CGI render of a weasel as a slippery double agent. Caught in a interrogation room mid-lie, wearing a cheap polyester suit slightly too large, hands raised defensively, nervous grin. Three different burner phones on the table. Tinker Tailor spy-who-came-in-cold vibes. Harsh overhead strip light, one-way mirror on the wall. Hyper-detailed fur. No borders, full bleed. Square format, portrait framing.""",
}

existing = {f.stem for f in OUT.glob('*.png')}
todo = {k: v for k, v in EXTRAS.items() if k not in existing}

if not todo:
    print("All extra avatars already generated!")
    sys.exit(0)

print(f"Generating {len(todo)} extra avatars ({len(existing)} already exist)...\n")

for name, prompt in todo.items():
    print(f"  {name}...", end=' ', flush=True)
    try:
        response = client.models.generate_content(
            model='gemini-2.5-flash-image',
            contents=prompt,
            config=types.GenerateContentConfig(
                response_modalities=['IMAGE', 'TEXT'],
            ),
        )
        saved = False
        for part in response.candidates[0].content.parts:
            if part.inline_data and part.inline_data.mime_type.startswith('image/'):
                out_path = OUT / f'{name}.png'
                out_path.write_bytes(part.inline_data.data)
                print(f"done ({len(part.inline_data.data)//1024}KB)")
                saved = True
                break
        if not saved:
            print("no image returned")
    except Exception as e:
        print(f"error: {e}")
    time.sleep(4)

print(f"\nDone! {len(list(OUT.glob('*.png')))} total avatars in library.")
