import io
import datetime
import yaml
import numpy as np
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import Response, JSONResponse, FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles

from skyfield.api import load, Star, wgs84
from skyfield.data import hipparcos
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.colors import LogNorm
import matplotlib.patheffects

import healpy as hp

matplotlib.use('Agg')

def load_config():
    with open("config.yaml", "r") as f:
        return yaml.safe_load(f)

CONFIG = load_config()

# --- TEMPLATE CONFIGURATION ---
templates = Jinja2Templates(directory="template")

astro_data = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"Loading configuration for {CONFIG['location']['name']}...")
    
    # 1. Load Time and Ephemeris
    astro_data['ts'] = load.timescale()
    astro_data['eph'] = load('de421.bsp')
    
    # 2. Load background stars
    with load.open(hipparcos.URL) as f:
        df = hipparcos.load_dataframe(f)
    astro_data['stars'] = df[df['magnitude'] <= 4.0]
    
    # 3. Define Observer from YAML
    loc = CONFIG['location']
    astro_data['observer'] = wgs84.latlon(loc['latitude'], loc['longitude'], elevation_m=loc['elevation'])
    
    # 4. Define Objects to Track
    objects = {
        'Sun': astro_data['eph']['sun'],
        'Moon': astro_data['eph']['moon'],
    }
    for src in CONFIG['sources']:
        objects[src['name']] = Star(
            ra_hours=tuple(src['ra']), 
            dec_degrees=tuple(src['dec'])
        )
    astro_data['objects'] = objects

    # --- NEW: Load Haslam Map ---
    print("Loading Haslam 408 MHz Map (this may take a moment)...")
    try:
        from pygdsm import GlobalSkyModel
        gsm = GlobalSkyModel(freq_unit='MHz')
        astro_data['haslam_map'] = gsm.generate(408)
        print("Haslam Map Loaded Successfully.")
    except Exception as e:
        print(f"FAILED to load Haslam map: {e}")
        print("Ensure 'pygdsm' and 'healpy' are installed: pip install pygdsm healpy")
    # ----------------------------
    
    print("System Ready.")
    yield
    print("Shutting down.")

app = FastAPI(lifespan=lifespan)

# Serve local static assets (CSS/JS/images/data) from ./static at /static
app.mount("/static", StaticFiles(directory="static"), name="static")

def get_current_data():
    ts = astro_data['ts']
    t = ts.now()
    observer = astro_data['observer']
    earth = astro_data['eph']['earth']
    
    # Calculate Track Times (e.g., next 24 hours)
    track_hours = CONFIG.get('plot', {}).get('track_hours', 24)
    times = ts.utc(t.utc_datetime().year, t.utc_datetime().month, t.utc_datetime().day, 
                   t.utc_datetime().hour, np.arange(0, track_hours*60, 10)) 
    
    topocentric_now = (earth + observer).at(t)
    topocentric_track = (earth + observer).at(times)

    results = []
    plot_data = [] 
    paths_data = [] 

    # LST Calculation
    t_gast = t.gast
    long_hours = CONFIG['location']['longitude'] / 15.0
    lst_decimal = (t_gast + long_hours) % 24
    
    lst_h = int(lst_decimal)
    lst_m = int((lst_decimal * 60) % 60)
    lst_s = int((lst_decimal * 3600) % 60)
    lst_str = f"{lst_h:02d}h {lst_m:02d}m {lst_s:02d}s"

    for name, obj in astro_data['objects'].items():
        # 1. Get CURRENT Position
        apparent = topocentric_now.observe(obj).apparent()
        alt, az, _ = apparent.altaz()
        ra, dec, _ = apparent.radec()
        
        # --- MODIFIED SECTION START ---
        # Only calculate/render the path if the source is CURRENTLY above the horizon
        if alt.degrees > 0:
            
            # Calculate future positions
            apparent_track = topocentric_track.observe(obj).apparent()
            alt_track, az_track, _ = apparent_track.altaz()
            
            # Filter: Even if the source is up now, parts of its future path might be below horizon (setting).
            # We mask those out so we don't draw lines through the "ground".
            mask = alt_track.degrees > 0
            if np.any(mask):
                r_track = 90 - alt_track.degrees[mask]
                theta_track = np.deg2rad(az_track.degrees[mask])
                
                if name == 'Sun': p_color = '#FFD700'
                elif name == 'Moon': p_color = '#C0C0C0'
                else: p_color = '#008B8B'
                
                paths_data.append((theta_track, r_track, p_color))
        # --- MODIFIED SECTION END ---

        results.append({
            "name": name,
            "alt": round(alt.degrees, 2),
            "az": round(az.degrees, 2),
            "ra": str(ra),
            "dec": str(dec)
        })

        # Add current position dot to plot (only if above horizon, with buffer)
        if alt.degrees > -5:
            r = 90 - alt.degrees
            theta = np.deg2rad(az.degrees)
            
            if name == 'Sun': color = '#FFD700'; size = 150
            elif name == 'Moon': color = '#C0C0C0'; size = 140
            else: color = '#00FFFF'; size = 80
            plot_data.append((theta, r, name, color, size))

    # Stars
    star_positions = topocentric_now.observe(Star.from_dataframe(astro_data['stars'])).apparent()
    star_alt, star_az, _ = star_positions.altaz()
    mask = star_alt.degrees > 0
    star_r = 90 - star_alt.degrees[mask]
    star_theta = np.deg2rad(star_az.degrees[mask])
    
    return {
        "time": {
            "utc": t.utc_strftime('%Y-%m-%d %H:%M:%S'),
            "local": t.astimezone(datetime.timezone(datetime.timedelta(hours=-8))).strftime('%Y-%m-%d %H:%M:%S'),
            "lst": lst_str
        },
        "sources": results,
        "plot_sources": plot_data,
        "plot_paths": paths_data,
        "plot_stars": (star_theta, star_r)
    }

# --- ENDPOINTS ---

@app.get("/") 
async def get_home(request: Request):
    return templates.TemplateResponse("template.html", {
        "request": request,
        "location": CONFIG['location']['name'],
        "lat": CONFIG['location']['latitude'],
        "lon": CONFIG['location']['longitude'],
        "elev": CONFIG['location']['elevation'],
        "refresh_rate": CONFIG.get('plot', {}).get('refresh_rate', 1000)
    })


@app.get("/rfi")
async def get_rfi():
    """Serve the standalone skyrfi.html at /rfi"""
    return FileResponse("skyrfi.html", media_type="text/html")

@app.get("/data")
async def get_data():
    data = get_current_data()
    return JSONResponse({"time": data['time'], "sources": data['sources']})

@app.get("/plot")
async def get_plot():
    # 1. Fetch live telescope/object data
    data = get_current_data()
    
    # 2. Setup the Polar Plot
    fig = plt.figure(figsize=(8, 8), dpi=100)
    ax = fig.add_subplot(111, projection='polar')
    
    # Styling: Dark Mode
    ax.set_facecolor('#0d0d0d')
    fig.patch.set_facecolor('#0d0d0d')
    
    # Orientation: North at top, Clockwise (E is right)
    ax.set_theta_zero_location('N')
    ax.set_theta_direction(-1)
    
    # Limits: Horizon (90) to Zenith (0)
    ax.set_ylim(0, 90)
    
    # --- FIXED GRID & LABELS ---
    # Define grid lines for Altitude 60° (r=30) and 30° (r=60)
    ax.set_yticks([30, 60])
    
    # Label them (Inner ring is higher altitude)
    ax.set_yticklabels(['60°', '30°'], color='#CCCCCC', fontsize=9, fontweight='bold')
    
    # Move the radial labels to the NE sector so they are readable
    ax.set_rlabel_position(45)
    
    # Draw the grid lines clearly
    ax.grid(True, color="#FFFFFF", linestyle='--', linewidth=0.8, alpha=0.3)
    ax.spines['polar'].set_visible(False)
    
    # Set Compass Labels
    angles = np.linspace(0, 2*np.pi, 8, endpoint=False)
    ax.set_xticks(angles)
    ax.set_xticklabels(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], 
                       color="#FFFFFF", fontsize=10, fontweight='bold')

    # --- HASLAM 408 MHz MAP BACKGROUND ---
    try:
        if 'haslam_map' in astro_data:
            # Create a local Alt/Az grid
            az_grid = np.linspace(0, 360, 150)
            alt_grid = np.linspace(0, 90, 150)
            AZ, ALT = np.meshgrid(az_grid, alt_grid)
            
            # Use Skyfield to find where these pixels point in the Galaxy right now
            ts = astro_data['ts']
            t = ts.now()
            observer = astro_data['observer']
            
            # Bind the observer to the current time 't'
            position = observer.at(t).from_altaz(alt_degrees=ALT.flatten(), az_degrees=AZ.flatten())
            
            gal_lat, gal_lon, _ = position.galactic_latlon()
            
            # Convert Galactic (lat/lon) to HEALPix (theta/phi)
            hp_theta = np.pi/2 - gal_lat.radians 
            hp_phi = gal_lon.radians
            
            # Interpolate the temperature from the Haslam map
            temps = hp.get_interp_val(astro_data['haslam_map'], hp_theta, hp_phi)
            temps_grid = temps.reshape(AZ.shape)
            
            # Map to Plot Coordinates
            R_plot = 90 - ALT
            Theta_plot = np.radians(AZ)
            
            # Plot using LogNorm for better contrast
            mesh = ax.pcolormesh(Theta_plot, R_plot, temps_grid, 
                                 cmap='magma', shading='auto', norm=LogNorm(), 
                                 alpha=0.4, zorder=0)
    except Exception as e:
        print(f"Error plotting background map: {e}")
    # --- END BACKGROUND ---

    # 3. Plot Background Stars
    theta_s, r_s = data['plot_stars']
    ax.scatter(theta_s, r_s, s=1.5, c='white', alpha=0.6, marker='.', zorder=1)

    # 4. Plot Antenna Beam (FWHM)
    beam_fwhm = CONFIG['antenna']['beam_fwhm']
    beam_radius = beam_fwhm / 2.0
    beam_theta = np.linspace(0, 2*np.pi, 100)
    beam_r = np.full(100, beam_radius) 
    
    ax.fill(beam_theta, beam_r, color='#00ff00', alpha=0.05, zorder=2)
    ax.plot(beam_theta, beam_r, color='#00ff00', linestyle='--', linewidth=1.0, alpha=0.4, zorder=2)
    ax.text(np.radians(45), beam_radius + 5, f"FWHM {beam_fwhm}°", 
            color='#00ff00', fontsize=8, alpha=0.6)

    # 5. Plot Object Paths (Tracks)
    for (theta, r, color) in data['plot_paths']:
        ax.scatter(theta, r, s=4, c=color, alpha=0.5, zorder=5)

    # 6. Plot Current Object Positions
    for (theta, r, name, color, size) in data['plot_sources']:
        if r <= 90:
            # Plot the dot
            ax.scatter(theta, r, c=color, s=size, zorder=10, edgecolors='black', linewidth=1)
            
            # Use annotation for safe labeling near Zenith (r=0)
            ax.annotate(
                name, 
                xy=(theta, r), 
                xytext=(0, -12),       # Shift text 12 points down
                textcoords='offset points', 
                color=color, 
                ha='center', 
                va='top', 
                fontsize=9, 
                fontweight='bold', 
                zorder=11,
                path_effects=[matplotlib.patheffects.withStroke(linewidth=2, foreground='black')]
            )

    # 7. Render to Buffer
    buf = io.BytesIO()
    plt.savefig(buf, format='png', bbox_inches='tight', pad_inches=0.1, facecolor='#0d0d0d')
    plt.close(fig)
    buf.seek(0)
    
    return Response(content=buf.getvalue(), media_type="image/png")

if __name__ == "__main__":
    import uvicorn
    server_conf = CONFIG.get('server', {})
    host = server_conf.get('host', '0.0.0.0')
    port = server_conf.get('port', 8000)
    
    print(f"Starting server at http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)