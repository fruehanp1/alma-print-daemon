var alma = require ('almarestapi-lib');
var fs = require('fs');
var pdf = require('html-pdf');

const temp = require('temp');
const {app, BrowserWindow, dialog, Menu} = require('electron');
const edge = require('electron-edge-js');
//const { printFile } = require('./lib/print');
const printer = require('node-native-printer');
const ipcMain = require('electron').ipcMain;
const log = require('electron-log');
const {autoUpdater} = require('electron-updater');
const defaultBorder = ".4"  //This was the hardcoded default pre-2.0.0-beta-03

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'silly';

let timer;
let configFile;
let configSettings;
let pdfOptions;
let printOptions;

let mainWindow;
let almaPrinters;
let almaPrinterQueues;
let localPrinterList;
let almaPrinterProfiles;
let useAlmaPrinters;
let mode;
let lastAlmaPrinter = 0;
let useLandscape = false;
let useColor = false;
let useLocalPrinter;
let menuOffset = 0;
//For classic printing using the browser window
let printDocs;
let docIndex = 0;
let total_document_count = 0;
let notPrinting = true;
let paused = true;

const getPrinterQueues = async (type, offset) => 
  await alma.getp(`/conf/printers?printout_queue=${type}&limit=100&offset=${offset}`);

const getPrintouts = async (printer_id = useAlmaPrinters, limit = 100) => 
  await alma.getp(`/task-lists/printouts?status=Pending${printer_id}&limit=${limit}`);

const markAsPrinted = async id =>
  await alma.postp(`/task-lists/printouts/${id}?op=mark_as_printed`, {});

const htmlToPdf = html => {
  const pdfFile = pdf.create(html, pdfOptions);
  return new Promise( (resolve, reject) => {
    pdfFile.toFile(temp.path({suffix: '.pdf'}), (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  })
}

const printDocumentsViaBrowser = async () => {
  console.log ('Entered printDocumentsViaBrowser');
  clearTimeout(timer);
  mainWindow.loadURL('File://' + __dirname + '\\docsRetrieving.html');
  printDocs = await getPrintouts();
  total_record_count  = printDocs.total_record_count;
  docIndex = 0;
  console.log ('Back from getDocuments; total_record_count = ' + total_record_count);
  if (total_record_count > 0) {
    notPrinting = false;
    console.log ('Load first document');
    mainWindow.loadURL('data:text/html;charset=utf-8,'  + encodeURIComponent(printDocs.printout[docIndex].letter));
  }
  else {
    notPrinting = true;
    if (configSettings.interval == 0) {
      mainWindow.loadURL('File://' + __dirname + '\\docsPrintedManual.html');
      //Don't set a timer....requests are done manually
      return;
    }
    else {
      mainWindow.loadURL('File://' + __dirname + '\\docsPrintedInterval.html');
      console.log ('No docs at all..set the timer');
      timer = setTimeout(getDocumentsTimerController, configSettings.interval  * 60000);
    }
  }
}

const printDocumentsViaPDF = async () => {
  console.log ('Entered printDocumentsViaPDF');
  clearTimeout(timer);
  console.log ('Timer cleared...ready to getPrintouts');
  console.log ('almaPrinters = ' + useAlmaPrinters);
  if (!service) {
    mainWindow.loadURL('File://' + __dirname + '\\docsRetrieving.html');
  }
  let printouts = await getPrintouts();
  console.log ('Back from getPrintouts');
  let total_record_count  = printouts.total_record_count;
  if (total_record_count && !service) {
    mainWindow.loadURL('File://' + __dirname + '\\docsPrinting.html');
  }
  while (total_record_count) {

    console.log ("Get Printouts number to print = " + total_record_count);
    for (const printout of printouts.printout) {
      try {
        console.log ("Should we get local printer settings?  lastAlmaPrinter = " + lastAlmaPrinter + ", next Alma Printer = " + printout.printer.value);
        if (lastAlmaPrinter != printout.printer.value) {
          getLocalPrinter(printout.printer.value);
        }

        let filename = (await htmlToPdf(printout.letter)).filename;
        //await printFile(filename)
        await printer.print (filename, printOptions)
        fs.unlinkSync(filename);
        /* Post File */
        await markAsPrinted(printout.id);
        console.log('printed file', printout.id)
      } catch(e) {
        console.error('Error', e);
      }
    }
    printouts =  await getPrintouts();
    total_record_count = printouts.total_record_count;
  } 

  if (!service) {
    if (configSettings.interval == 0) {
      mainWindow.loadURL('File://' + __dirname + '\\docsPrintedManual.html');
      //Don't set a timer....requests are done manually
      return;
    }
    else {
      mainWindow.loadURL('File://' + __dirname + '\\docsPrintedInterval.html');
    }
  }
  console.log ('set timer to get next batch of documents to print');
  timer = setTimeout(getDocumentsTimerController, configSettings.interval  * 60000);
}

const getAlmaPrinters = async () => {
  //Get Alma printers in groups to fix GitHub issue #35.
  let nextBatch;
  almaPrinterQueues = await getPrinterQueues('true', 0);
  let total_alma_printers = almaPrinterQueues.total_record_count;
  let current_printer_count = almaPrinterQueues.printer.length;
  while (total_alma_printers > current_printer_count) {
    nextBatch = await getPrinterQueues('true', current_printer_count);
    for (const printer of nextBatch.printer) {
      almaPrinterQueues.printer.splice(almaPrinterQueues.printer.length, 0, printer);
    }
    current_printer_count = current_printer_count + nextBatch.printer.length;
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', function() {
    console.log ("app ready!!!!!");
    createWindow();
})

// Main line *************** 
//Set up macOS-specific stuff
const isMac = process.platform === 'darwin';
console.log ('isMac = ' + isMac);
if (isMac) {
  menuOffset = 1;
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log ("!!!!!!!!!Duplicate instance!!!!!!!!!")
  app.quit();
} 
else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } 
  })
}

//WriteLog ("at startup APIKEY = " + process.env.ALMA_APIKEY);
//WriteLog ("at startup APIPATH = " + process.env.ALMA_APIPATH);
console.log ('Arguments = ' + process.argv);
let setup = process.argv.indexOf('setup')==-1?false:true;
console.log ('setup = ' + setup);
let service = process.argv.indexOf('service')==-1?false:true;
console.log ('service = ' + service);

//getAlmaPrinters ();

success = initConfiguration();
if (!success && !setup) {
  console.log ("Config not found and no setup argument -> switch to setup!");
  setup = true;
}

if (!setup) {
  if (configSettings.almaPrinterProfiles == undefined) {
    console.log ("Alma printer profiles not defined -> switch to setup!")
    setup = true;
  }
  else if (configSettings.almaPrinterProfiles.length == 0) {
    console.log ("Alma printer profiles length = 0 -> switch to setup!")
    setup = true;
  }
}

//if (setup) {
  console.log ("Getting Alma Print Queues");
  getAlmaPrinters();
  console.log ("Back from getAlmaPrinters()");
//}

function createWindow () {
  if (setup || !service) {
    mainWindow = new BrowserWindow({
      width: 600,
      height: 595,
      show: true,
      title: "Alma Print Daemon 2.1.0",
      webPreferences: {
        //preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: true
      }
    })

    mainWindow.webContents.on('did-finish-load', () => {
      if (paused || notPrinting) return;
      console.log ('Document loaded...print it');
      if (lastAlmaPrinter != printDocs.printout[docIndex].printer.value) {
        getLocalPrinter(printDocs.printout[docIndex].printer.value);
      }
      mainWindow.webContents.print({silent: true, landscape: useLandscape, color: useColor, deviceName: useLocalPrinter}, function(success){
        //await markAsPrinted(printDocs.printout[docIndex].id);
        markAsPrinted(printDocs.printout[docIndex].id);
        docIndex++;
        if (docIndex < total_record_count) {
          console.log ('More docs....load next one:  ' + docIndex);
          mainWindow.loadURL('data:text/html;charset=utf-8,'  + encodeURIComponent(printDocs.printout[docIndex].letter));
        }
        else {
          notPrinting = true;
          if (configSettings.interval == 0) {
            mainWindow.loadURL('File://' + __dirname + '\\docsPrintedManual.html');
            //Don't set a timer....requests are done manually
            return;
          }
          else {
            mainWindow.loadURL('File://' + __dirname + '\\docsPrintedInterval.html');
            console.log ('No more docs...set the timer');
            timer = setTimeout(getDocumentsTimerController, configSettings.interval  * 60000);
          }
        }
      })
    })
    
    //mainWindow.webContents.openDevTools();
    if (setup) {
      WriteLog ('Started with SETUP parameter....create mainWindow');
      WriteLog ('Try to load configWindow.html');
      mainWindow.loadURL('File://' + __dirname + '\\configWindow.html');
      WriteLog ('After trying to load configWindow.html'); 
      localPrinterList = mainWindow.webContents.getPrinters();
      //console.log (localPrinterList);
      mainWindow.webContents.on('did-finish-load', () => {
        //console.log ('did-finish-load for configWindow');
        //console.log ('Send saved settings to configWindow');
        mainWindow.webContents.send('send-settings', configSettings);
        //console.log ('Send local printers to configWindow');
        mainWindow.webContents.send('local-printers', localPrinterList);
        //console.log ('Send alma printers to configWindow');
        //console.log (almaPrinterQueues);
        mainWindow.webContents.send('alma-printers', almaPrinterQueues);
      })
    }
    else if (!service) {
      //If manual requesting...
      if (configSettings.interval == 0) {
        mainWindow.loadURL('File://' + __dirname + '\\docsPrintedManual.html');
      }
      else {
      //If autoStart enabled, start printing
        if (configSettings.autoStart == 'true') {
          console.log ("Start printing since autoStart = true");
          paused = false;
          printDocumentsViaBrowser();
        }
        else {
          //Wait for user to start printing
          console.log ("Start in paused mode since autoStart = false");
          paused = true;
          mainWindow.loadURL('File://' + __dirname + '\\docsPrintIntervalPaused.html');
        }
      }
    }

    setMenus();

    mainWindow.on('close', () => {
      app.quit();
    })
  }
  else {
    console.log ("Start printing as a service");
    //If the interval isn't set, set it to default of 2 minutes
    if (configSettings.interval == 0) {
      configSettings.interval = 2;
    }
    printDocumentsViaPDF();
  }
}

//Function to control getting documents when the timer hits
function getDocumentsTimerController() {
  console.log ('Timer triggered');
  if (service)
    printDocumentsViaPDF();
  else
    printDocumentsViaBrowser();
}

//Function to read config file and set options accordingly
function initConfiguration() {
  let configExists = true;
  let configData;

  configFile =  app.getPath("userData") + "\\alma-print-config.json";
  console.log (configFile);

  try {
    configData = fs.readFileSync(configFile);
  }
  catch (e) {
    configExists = false;
    configData = "{\"region\": \"ap\",\"apiKey\": \"\",\"interval\": \"5\",\"autoStart\": \"false\",\"almaPrinterProfiles\": []}";
    configSettings = JSON.parse(configData);
    let message = 'Please set your configuration options in ' + configFile;
    WriteLog(message);
    return false;
    //app.quit();
  }

  if (configExists) {

    const configJSON = configData.toString('utf8');
    configSettings = JSON.parse(configJSON);
    if (configSettings["almaPrinter"]) {
      console.log ('Config file must be converted!');
      convertConfigFile(configJSON);
      console.log ("Back from converting config file");
      fs.writeFileSync(configFile, JSON.stringify(configSettings));
      configData = fs.readFileSync(configFile);
    }
    else {
      console.log ('Config file already converted!');
    }

    console.log('Region = ' + configSettings.region);
    console.log('API Key = ' + configSettings.apiKey);
    console.log('Interval  = ' + configSettings.interval);
    console.log('Auto Start = ' + configSettings.autoStart);
    console.log('Alma Printer Profiles = ' + JSON.stringify(configSettings.almaPrinterProfiles));
    console.log ('Writing config values to log');
    let d = new Date();
    WriteLog ('******************************************************');
    WriteLog ('Alma Print Daemon/Service startup at ' + d.toISOString() + '.');
    WriteLog ('Configuration Parameters:');
    WriteLog ('Region = ' + configSettings.region);
    //WriteLog ('API Key = ' + configSettings.apiKey);
    WriteLog ('API Key = hidden');
    WriteLog ('Interval (minutes) = ' + configSettings.interval);
    WriteLog('Auto Start = ' + configSettings.autoStart);
    WriteLog('Alma Printer Profiles = ' + JSON.stringify(configSettings.almaPrinterProfiles));

    //printer.setPrinter(configSettings.localPrinter);
    printer.setPrinter('Microsoft Print to PDF');
    //printer.setPrinter('Generic / Text Only');

    if (configSettings.almaPrinterProfiles.length > 0) {
      useAlmaPrinters = '&printer_id=';
      for (let i = 0; i < configSettings.almaPrinterProfiles.length; i++) {
        if (i > 0) {
          useAlmaPrinters = useAlmaPrinters + ","
        }
        useAlmaPrinters = useAlmaPrinters + configSettings.almaPrinterProfiles[i].almaPrinter;
      }
    }
    process.env.ALMA_APIKEY = configSettings.apiKey;
    process.env.ALMA_APIPATH = 'https://api-' + configSettings.region + '.hosted.exlibrisgroup.com/almaws/v1';
    //WriteLog ("from initConfiguration, setting API_KEY = " + process.env.ALMA_APIKEY);
    //WriteLog ("from initConfiguration, setting APIPATH = " + process.env.ALMA_APIPATH);
    alma.setOptions (process.env.ALMA_APIKEY, process.env.ALMA_APIPATH);
    return true;
  } 
  else {
    return false;
    //WriteLog ('Alma Print Service configuration file does not exist; writing base config.  Please edit with correct values.');
    configData = "{\"region\": \"enter region here\",\"apiKey\": \"enter APIKEY here\",\"almaPrinter\": \"enter Alma Printer IDs here\",\"localPrinter\": \"enter local printer name here\",\"interval\": \"10\",\"orientation\": \"portrait\",\"tempDir\": \"c:\\\\temp\",\"batchSize\": \"100\"}";
    fs.writeFileSync(configFile, configData);
  }
}

//Function to write log messages
function WriteLog(message) {
  let d = new Date();
  fs.appendFileSync(app.getPath("userData") + '/log.alma-print-daemon.' + d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1)  + "-" + d.getUTCDate() ,  d.toISOString() + ":  " + message + "\n");
}

//Catch 'save-settings' from renderer
ipcMain.on('save-settings', function(e, configString){
  console.log ('from renderer: user saved settings = ' + configString);
  // Write JSON Alma config file
  fs.writeFileSync(configFile, configString);
  //configWindow.close();
  //Reset last Alma Printer used as settings for that printer may have changed
  lastAlmaPrinter = 0;
  // quit and relaunch app to make new settings effective
  //app.relaunch();
  //app.quit();
  //Reload configuration
  initConfiguration();
  if (almaPrinterQueues == undefined) {
    console.log ('Just saved settings - get alma printer queues, if necessary');
    getAlmaPrinters();
  }

  setup = false;
  //...and resume printing
  if (configSettings.interval == 0) {
    mainWindow.loadURL('File://' + __dirname + '\\docsPrintedManual.html');
  }
  else {
    if (service)
      printDocumentsViaPDF();
    else
      printDocumentsViaBrowser();
  }
})

//Catch "Print now" from renderer
ipcMain.on('print-now', function (e){
  console.log('from renderer:  user clicked print now');
  paused = false;
  //Has a UI, so print via browser
  printDocumentsViaBrowser(0);
})

//Catch "Continue printing" from renderer
ipcMain.on('print-continue', function(e) {
  console.log('from renderer:  user clicked continue printing');
  setup = false;
  paused = false;
  //Has a UI, so print via browser
  printDocumentsViaBrowser();
})

//Catch "Pause printing" from renderer
ipcMain.on('print-pause', function (e){
  console.log('from renderer:  user clicked pause printing');
  //clear the timer since user has paused printing
  clearTimeout (timer);
  paused = true;
  mainWindow.loadURL('File://' + __dirname + '\\docsPrintIntervalPaused.html');
})

ipcMain.on('display-config', function (e){
  displayConfigPage();
}) 

ipcMain.on('check-for-update', function (e){
  checkForSoftwareUpdate();
})

ipcMain.on('restart_app', () => {
  autoUpdater.quitAndInstall();
});

autoUpdater.on('update-available', () => {
  mainWindow.webContents.send('update_available');
});

autoUpdater.on('update-downloaded', () => {
  mainWindow.webContents.send('update_downloaded');
});

autoUpdater.on('update-not-available', () => {
  mainWindow.webContents.send('update_not_available');
});

function getLocalPrinter(almaPrinter) {
  let i, pageOptions;

  console.log ("in getLocalPrinter");
  //Save last Alma printer so we don't come here to get local printer settings for each document if not necessary
  lastAlmaPrinter = almaPrinter;
  for (i = 0; configSettings.almaPrinterProfiles.length; i++) {
    if (configSettings.almaPrinterProfiles[i].almaPrinter == almaPrinter) {
      useColor = configSettings.almaPrinterProfiles[i].color == 'true'?true:false;
      useLocalPrinter = decodeURIComponent(configSettings.almaPrinterProfiles[i].localPrinter);
      if (configSettings.almaPrinterProfiles[i].orientation == "landscape") {
        useLandscape = true;
      }
      else {
        useLandscape = false;
      }
      break;
    }
  }
  let letterFormat, borderUnits, borderTop, borderRight, borderBottom, borderLeft, customHeight, customWidth;
  if (configSettings.almaPrinterProfiles[i].letterFormat == undefined) 
    letterFormat = 'Letter';
  else
    letterFormat = configSettings.almaPrinterProfiles[i].letterFormat;

  if (configSettings.almaPrinterProfiles[i].borderUnits == undefined) 
    borderUnits = "in";
  else
    borderUnits = configSettings.almaPrinterProfiles[i].borderUnits;

  borderTop = setBorderValue(configSettings.almaPrinterProfiles[i].borderTop) + borderUnits;
  borderRight = setBorderValue(configSettings.almaPrinterProfiles[i].borderRight) + borderUnits;
  borderBottom = setBorderValue(configSettings.almaPrinterProfiles[i].borderBottom) + borderUnits;
  borderLeft = setBorderValue(configSettings.almaPrinterProfiles[i].borderLeft) + borderUnits;
  customHeight = configSettings.almaPrinterProfiles[i].pageHeight + borderUnits;
  customWidth = configSettings.almaPrinterProfiles[i].pageWidth + borderUnits;
  
  if (letterFormat == 'Custom') 
    pdfOptions = {
      height: customHeight,
      width: customWidth,
      border: {
        top: borderTop,            
        right: borderRight,
        bottom: borderBottom,
        left: borderLeft
      },
      script: 'lib\\pdf_a4_portrait.js',
      phantomPath: 'lib\\phantomjs.exe'
    };
  else
    pdfOptions = {
      format: letterFormat,
      orientation: configSettings.almaPrinterProfiles[i].orientations,
      border: {
        top: borderTop,            
        right: borderRight,
        bottom: borderBottom,
        left: borderLeft
      },
      script: 'lib\\pdf_a4_portrait.js',
      phantomPath: 'lib\\phantomjs.exe'
    };
    console.log ('pdfOptions = ' + JSON.stringify(pdfOptions));
  
  printOptions = {
        "landscape": useLandscape,
        "color": useColor
  }
  printer.setPrinter (useLocalPrinter);
  console.log ("Local printer settings:  useLandscape = " + useLandscape + " useColor = " + useColor + " useLocalPrinter = " + useLocalPrinter);
}

function setBorderValue (value) {
  if (value == undefined)
    return defaultBorder;
  else if (isNaN(value))
    return defaultBorder;
  else
    return value;
}

function displayConfigPage() {

    //clear timer so request isn't trigered.
    clearTimeout(timer);
    //switch to SETUP mode
    setup = true;
    WriteLog ('Try to load configWindow.html');
    mainWindow.loadURL('File://' + __dirname + '\\configWindow.html');
    WriteLog ('After trying to load configWindow.html'); 
    localPrinterList = mainWindow.webContents.getPrinters();
    //console.log (localPrinterList);
    mainWindow.webContents.on('did-finish-load', () => {
      if (setup) {
        //console.log ('did-finish-load for configWindow');
        //console.log ('Send saved settings to configWindow');
        mainWindow.webContents.send('send-settings', configSettings);
        //console.log ('Send local printers to configWindow');
        mainWindow.webContents.send('local-printers', localPrinterList);
        //console.log ('Send alma printers to configWindow');
        WriteLog('In displayConfigPage, on-did-finish-load, sending Alma Printer Queues = ' + JSON.stringify(almaPrinterQueues));
        mainWindow.webContents.send('alma-printers', almaPrinterQueues);
      }
    })
}

function checkForSoftwareUpdate() {
  autoUpdater.allowPrerelease = false;
  autoUpdater.checkForUpdatesAndNotify();
}

function convertConfigFile() {
  var jsonPrinterProfileObj;
  var almaPrinterProfiles = [];

  for (let i = 0; i < configSettings.almaPrinter.length; i++) {
    //Build Alma Printer Profile for each almaPrinter
    jsonPrinterProfileObj = {almaPrinter: configSettings.almaPrinter[i], localPrinter: configSettings.localPrinter, orientation: configSettings.orientation, color: "true"};
    almaPrinterProfiles[i] = jsonPrinterProfileObj;
  }
  delete configSettings['almaPrinter'];
  delete configSettings['localPrinter'];
  delete configSettings['orientation'];
  configSettings.almaPrinterProfiles = almaPrinterProfiles;

  console.log ("New config file = " + JSON.stringify(configSettings));
}

function setMenus(){
  console.log ('in setMenus');
  
  if (isMac) {
    mainMenuTemplate.unshift ({
      label: app.name,
      submenu: [
        {role: 'about'},
        {type: 'separator'},
        {role: 'services', submenu: []},
        {type: 'separator'},
        {role: 'hide'},
        {role: 'hideothers'},
        {role: 'unhide'},
        {type: 'separator'},
        {role: 'quit'}
      ]
    })
  }

  const mainMenu = Menu.buildFromTemplate(mainMenuTemplate);
  Menu.setApplicationMenu (mainMenu);
}

const mainMenuTemplate = [
  {
    label:'File',
    visible: true,
    submenu:[
      {
        label: 'Exit',
        accelerator: process.platform == 'darwin' ? 'Command+Q' : 'Alt+F4',
        click(){
          app.quit();
        }
      }
    ],
  },
  {
    label: 'Edit',
    role: 'editMenu'
  }
]