Octopus 0.1 - analyse AI 0.FIRST V

This repository contains the Octopus trading AI: the engine (js/tradl-lab.js) and its Python worker (js/tradl-ai-worker.js). The models it ships with - a supervised online predictor, a
reinforcement-learning agent, an NLP sentiment classifier, an AutoML auto-optimizer, an explainable "X-ray" decomposition of the linear models, and the feature engineering - are
written in Python, embedded inside tradl-lab.js, and executed directly in the browser through Pyodide. Octopus predicts the next moves on a price chart, searches on its own for the best combination of model, features and horizon, and explains exactly which indicators it reads and why.

Important: this is the first version of Octopus (0.1), and the bot has never been tested on a real financial market. It has only been trained and evaluated on a fully artificial, simulated market generated from mathematical equations. Nothing in this project should be considered financial advice, and the bot makes no claim to predict real-world market behavior. Consequently, no claim is made regarding real-world trading performance, profitability, robustness, or suitability for live trading.


This is only the bot, not a complete application, so it cannot run on its own. To run it you need a host environment that provides three things. First, a web page that loads these two
scripts together with Pyodide (which brings Python to the browser) and CodeMirror (the in-browser code editor). Second, the scientific Python stack the models rely on - numpy, pandas and
scikit-learn - which Pyodide downloads on demand the first time the bot runs. Third, a market API exposed on the global object window.TradSim, through which the bot reads candles (marketData),
draws its forecast on the chart, and reads the current price. The host page, the market simulator
and the terminal interface are not part of this repository. Note also that the bot must be servedover HTTP rather than opened as a local file, because it loads Python inside a Web Worker.

The code is split across the two files. js/tradl-lab.js is the Octopus engine: it holds theembedded Python models, sends them to a Web Worker to be run by Pyodide, draws the live
prediction cone on the chart, and renders the analysis panels - news sentiment, the "brain"X-ray that decomposes a prediction indicator by indicator, and the AutoML auto-optimization with
its reasoning journal. js/tradl-ai-worker.js is the Web Worker itself: it boots Pyodide, loadsthe required packages, runs the Python code it receives, and returns the results to the page as JSON.

The guiding idea is an honest AI: no look-ahead (the target is always the next candle),prequential evaluation (predict before learning, so the reported reliability is real), monitoring for overfitting, and a deliberately small edge because the market is near-efficient. The figures are meant to be trustworthy rather than impressive.

License: MIT - see the LICENSE file.
