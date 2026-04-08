#!/usr/bin/env python3
"""Generate unique photorealistic CGI spy-themed avatars for each agent."""

import os, sys, time
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(os.path.expanduser('~/claudeclaw/.env'))

from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ['GOOGLE_AI_STUDIO_KEY'])
OUT = Path(__file__).parent / 'avatars'
OUT.mkdir(exist_ok=True)

AGENTS = {
    'wolf': """Photorealistic CGI render of a grey wolf as a secret agent. Standing on a foggy London rooftop at night, wearing a long dark overcoat with the collar popped, leather gloves. One paw holds a silenced pistol pointed down. Wind blowing through fur. Inspired by John le Carré cold war spies. Moody blue-grey lighting, rain-slicked surfaces. Cinematic, hyper-detailed fur and fabric textures. Square format, portrait framing.""",

    'fox': """Photorealistic CGI render of a red fox as a glamorous spy at a Monte Carlo casino. Wearing a perfectly tailored cream dinner jacket with black lapels, pocket square. Leaning against a roulette table with a stack of chips, sly grin. Warm golden lighting from chandeliers, bokeh background of wealthy patrons. James Bond Casino Royale vibes. Hyper-detailed fur, realistic fabric. Square format, portrait framing.""",

    'bull': """Photorealistic CGI render of a muscular bull as an action spy. Mid-stride walking away from an explosion behind him, wearing a tactical black suit with loosened tie. Aviator sunglasses. Ethan Hunt / Mission Impossible energy. Fire and debris in the background, dust particles in the air. Dramatic orange and black lighting. Hyper-detailed skin texture and muscles. Square format, portrait framing.""",

    'mink': """Photorealistic CGI render of a sleek dark mink as a sophisticated intelligence analyst. Sitting in a dimly lit study surrounded by classified documents and monitors, wearing a tailored charcoal turtleneck and wire-frame glasses. Holding a fountain pen thoughtfully. George Smiley / Tinker Tailor vibes. Warm desk lamp lighting, green banker's lamp glow. Hyper-detailed fur. Square format, portrait framing.""",

    'otter': """Photorealistic CGI render of a sea otter as a charming undercover spy at a beach resort. Wearing a linen suit with the shirt unbuttoned, no tie, holding a tropical cocktail with an umbrella. Sitting in a cabana chair by a turquoise pool. Relaxed but alert. Roger Moore Bond vibes. Bright warm sunlight, palm trees. Hyper-detailed wet-look fur. Square format, portrait framing.""",

    'lynx': """Photorealistic CGI render of a lynx wildcat as a stealth operative. Crouching on a fire escape in a neon-lit Tokyo alley at night, wearing a sleek black tactical suit. Night vision goggles pushed up on forehead, tufted ears alert. Splinter Cell / Metal Gear vibes. Neon pink and cyan reflections on wet metal. Hyper-detailed fur and gear. Square format, portrait framing.""",

    'badger': """Photorealistic CGI render of a honey badger as a grizzled veteran spy. Standing in a dusty Middle Eastern marketplace, wearing a weathered safari jacket and cargo pants. Scarred face, intense stare, arms crossed. Indiana Jones meets Jason Bourne energy. Golden hour desert lighting, market stalls blurred behind. Hyper-detailed coarse fur. Square format, portrait framing.""",

    'coyote': """Photorealistic CGI render of a coyote as a smooth-talking con artist spy. In a high-stakes poker room, wearing a burgundy velvet blazer with a gold watch. Shuffling poker chips with one paw, knowing smirk. Ocean's Eleven heist vibes. Smoky atmosphere, dramatic overhead spotlight. Hyper-detailed fur, realistic fabric sheen. Square format, portrait framing.""",

    'panther': """Photorealistic CGI render of a black panther as an elite assassin spy. Standing in shadow in a marble-floored opera house balcony, wearing an immaculate all-black three-piece suit. Only the green eyes catch the light. Holding opera glasses. Sleek and deadly. John Wick elegance. Dramatic chiaroscuro lighting. Hyper-detailed dark fur with subtle sheen. Square format, portrait framing.""",

    'jaguar': """Photorealistic CGI render of a jaguar as a tech specialist spy. In a high-tech command center surrounded by holographic displays and screens, wearing a fitted dark navy suit with an earpiece. Typing on a floating keyboard, screens reflecting in eyes. Q from James Bond meets Mr. Robot vibes. Blue and white screen glow lighting. Hyper-detailed spotted fur. Square format, portrait framing.""",

    'bison': """Photorealistic CGI render of an American bison as a Secret Service bodyguard spy. Standing stoically in front of the White House at dusk, wearing a dark suit with American flag pin, earpiece in, hands clasped in front. Massive and imposing. Olympus Has Fallen energy. Dramatic sunset backlighting, silhouette effect. Hyper-detailed shaggy fur. Square format, portrait framing.""",

    'ferret': """Photorealistic CGI render of a ferret as a wiry intelligence courier. Darting through a crowded European train station, wearing a trench coat and flat cap, clutching a leather briefcase. Looking over shoulder nervously. The Third Man / Bourne Identity chase vibes. Motion blur on crowd, sharp focus on ferret. Vintage tungsten lighting. Hyper-detailed fur. Square format, portrait framing.""",

    'hound': """Photorealistic CGI render of a bloodhound as a classic detective spy. Standing under a streetlamp on a rainy cobblestone street in Paris, wearing a belted trench coat and fedora. Nose tilted up, sniffing the air. Long ears dripping with rain. Humphrey Bogart noir vibes. Black and white with selective warm color on the streetlamp. Hyper-detailed wrinkled face. Square format, portrait framing.""",

    'rabbit': """Photorealistic CGI render of a white rabbit as an unlikely spy recruit. Peeking around a corner in a sleek modern MI6-style headquarters hallway, wearing an oversized suit that's slightly too big. Big eyes, ears perked up, holding a gadget watch. New recruit energy, Kingsman vibes. Clean white and glass architecture, fluorescent lighting. Hyper-detailed soft white fur. Square format, portrait framing.""",

    'mole': """Photorealistic CGI render of a mole as a mole (double agent). Sitting alone in a dimly lit interrogation room, wearing a rumpled grey suit, tie loosened. Small round glasses reflecting a single overhead light. Papers and a coffee cup on the metal table. Tense, sweating. Bridge of Spies cold war interrogation vibes. Harsh single light source from above. Hyper-detailed velvety fur. Square format, portrait framing.""",
}

# Remove old cartoon versions
for f in OUT.glob('*.png'):
    f.unlink()
    print(f"  Removed old {f.name}")

print(f"\nGenerating {len(AGENTS)} photorealistic spy avatars...\n")

for name, prompt in AGENTS.items():
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

print("\nAll done!")
