import speech_recognition as sr
import pyttsx3
import os
import webbrowser
import time
from datetime import datetime
from dotenv import load_dotenv
from openai import OpenAI
import json
import sys
import re

# ====================== CLEAN TERMINAL ======================
os.environ["PYALSA_DEBUG"] = "0"
os.environ["SDL_AUDIODRIVER"] = "dummy"

load_dotenv()

# ====================== SETUP ======================
recognizer = sr.Recognizer()
engine = pyttsx3.init()
engine.setProperty('rate', 145)
engine.setProperty('volume', 1.0)

client = OpenAI(
    api_key=os.getenv("OPENROUTER_API_KEY"),
    base_url="https://openrouter.ai/api/v1"
)

# ====================== MODELS (FALLBACK SYSTEM) ======================
MODELS = [
    "stepfun/step-3.5-flash:free",
    "mistralai/mistral-7b-instruct:free",
    "openchat/openchat-7b:free"
]

# ====================== SPEAK ======================
def speak(text):
    print("Jarvis:", text)
    engine.say(text)
    engine.runAndWait()

# ====================== LISTEN ======================
def listen():
    speak("Listening now...")

    with sr.Microphone() as source:
        recognizer.adjust_for_ambient_noise(source, duration=1)

        try:
            audio = recognizer.listen(source, timeout=8, phrase_time_limit=8)
            text = recognizer.recognize_google(audio)
            print("You said:", text)
            speak("Processing your request...")
            return text

        except sr.WaitTimeoutError:
            return None

        except sr.UnknownValueError:
            speak("I didn't catch that.")
            return None

        except sr.RequestError:
            speak("Network issue.")
            return None

# ====================== ACTIONS ======================
def open_notepad():
    os.system("gedit &")
    speak("Opening text editor.")

def open_browser():
    webbrowser.open("https://www.google.com")
    speak("Opening browser.")

def open_youtube():
    webbrowser.open("https://www.youtube.com")
    speak("Opening YouTube.")

def open_word():
    os.system("libreoffice --writer &")
    speak("Opening word processor.")

def open_terminal():
    os.system("gnome-terminal &")
    speak("Opening terminal.")

def open_vlc():
    os.system("vlc &")
    speak("Opening VLC.")

def check_time():
    now = datetime.now()
    speak(f"The time is {now.strftime('%I:%M %p')}")

def increase_volume():
    os.system("amixer -D pulse sset Master 10%+")
    speak("Volume increased.")

def decrease_volume():
    os.system("amixer -D pulse sset Master 10%-")
    speak("Volume decreased.")

# ====================== SAFE JSON ======================
def extract_json(text):
    try:
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            return json.loads(match.group())
    except:
        return None
    return None

# ====================== AI CALL WITH FALLBACK ======================
def call_ai(messages):
    for model in MODELS:
        try:
            print(f"Trying model: {model}")
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=120,
                temperature=0.4
            )
            return response
        except Exception as e:
            print(f"Model {model} failed:", e)
            continue
    return None

# ====================== AI PROCESSING ======================
def process_with_ai(user_text):
    system_prompt = """
You are Jarvis.

Respond ONLY in JSON:

{
  "reply": "short response (max 10 words)",
  "action": "none" or one of:
  open_notepad, open_browser, open_youtube, open_word, open_terminal, open_vlc, check_time, increase_volume, decrease_volume
}

Rules:
- Keep reply VERY SHORT
- Always valid JSON
"""

    try:
        time.sleep(1.5)  # prevent rate limit

        response = call_ai([
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text}
        ])

        if response is None:
            raise ValueError("All models failed")

        raw = response.choices[0].message.content

        if raw is None:
            raise ValueError("Empty response")

        raw = raw.strip()
        print("RAW AI:", raw)

        data = extract_json(raw)

        if not data:
            raise ValueError("Invalid JSON")

        reply = data.get("reply", "Okay.")
        action = data.get("action", "none")

        speak(reply)

        # EXECUTE ACTION
        execute_action(action)

    except Exception as e:
        print("DEBUG ERROR:", str(e))
        offline_fallback(user_text)

# ====================== OFFLINE FALLBACK ======================
def offline_fallback(text):
    text = text.lower()

    if "time" in text:
        check_time()
    elif "youtube" in text:
        open_youtube()
    elif "browser" in text or "google" in text:
        open_browser()
    elif "notepad" in text or "editor" in text:
        open_notepad()
    elif "terminal" in text:
        open_terminal()
    elif "vlc" in text or "video" in text:
        open_vlc()
    elif "volume up" in text:
        increase_volume()
    elif "volume down" in text:
        decrease_volume()
    else:
        speak("I'm having connection issues, please try again.")

# ====================== EXECUTOR ======================
def execute_action(action):
    if action == "open_notepad":
        open_notepad()
    elif action == "open_browser":
        open_browser()
    elif action == "open_youtube":
        open_youtube()
    elif action == "open_word":
        open_word()
    elif action == "open_terminal":
        open_terminal()
    elif action == "open_vlc":
        open_vlc()
    elif action == "check_time":
        check_time()
    elif action == "increase_volume":
        increase_volume()
    elif action == "decrease_volume":
        decrease_volume()

# ====================== MAIN ======================
speak("Hello, I am Jarvis.")
speak("I can control your computer with your voice.")

while True:
    user_input = listen()

    if user_input:
        if any(word in user_input.lower() for word in ["exit", "stop", "shutdown", "goodbye"]):
            speak("Goodbye.")
            break

        process_with_ai(user_input)

    time.sleep(0.5)