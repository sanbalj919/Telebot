  var express = require('express');
  var app = express();
  var bodyParser = require('body-parser');
  const axios = require('axios')
  const fs = require('fs');
  const url = require("url");
  var querystring = require('querystring');
  var randomString = require('random-string');

  var MongoClient = require('mongodb').MongoClient;
  var kyclist = null;
  var intentDB = null;
  var db = null;
  var mongo_url = "mongodb://telemongodb:PknG4jZ5iozd4Zx50YU4e1vK0gYIBsLyNuil1Vi3HEqb1YKimZQirv0SbUMBbeuhBdp3A5AUVtrQ1KjSmC2CsA%3D%3D@telemongodb.documents.azure.com:10255/?ssl=true&replicaSet=globaldb";
  var kycbotURL = "https://api.telegram.org/bot576925049:AAHrzLIRFFZFd-tU8IPxElcaTjazCGcVy8c/sendMessage";
  var drbotURL = "https://api.telegram.org/bot669682041:AAFDHDJwISry6IWOVNYDMGikL_dMVs2pAok/sendMessage"
  //var mongo_url = 'mongodb://localhost:27017/payments';
  MongoClient.connect(mongo_url, function (err, database) {
      console.log('Database connected:'+database)
      db = database.db('payments')
      kyclist = db.collection('kyclist');
  });

  app.use(express.static('pages'));

  app.use(bodyParser.json()); // for parsing application/json
  app.use(bodyParser.urlencoded({
    extended: true
  })); // for parsing application/x-www-form-urlencoded

  app.get('/',function(req,res){ 
    console.log("SANTY BOT: NOT API Request - Normal GET Req");
    res.sendFile(__dirname+'/pages/index.html');
  });

  app.get('/testWA', function(req, res) {
    console.log('Infobip: Sending WhatsApp')
    //postWAMessageviaInfoBip("Hello buddy! Please work","971553043197")
    res.send("All the best")
  });

  app.post('/wa-message', function(req,res) {
    console.log('Chat2Brand:: Webhook RECEIVED Message from WhatsApp transport')
    console.log(JSON.stringify(req.body))
    var message = req.body
    var text = message.text
    var clientId = message.client_id
    var en = 'en'
    var session_id = '123456'

    var dialogFlowURL = "https://api.dialogflow.com/v1/query";

    let data = JSON.stringify({
                        lang: en,
                        query: text,
                        sessionId: session_id
                      })

    axios.post(dialogFlowURL, data, {
        headers: { "Content-Type":"application/json", "Authorization":"Bearer 2a745c0a38ad40128518897038ebbbfd" }
        })
        .then(response => {
          console.log('Response from Dialog Flow HR Bot:'+JSON.stringify(response.data))
          let dfSpeech = response.data.result.speech
          postC2BMessage(clientId,dfSpeech,'whatsapp',res)
        })  
        .catch(err => {
          console.log('Error :', err)
        })
    res.send("BOT Got your message!")
  });


  app.post('/ibwa-message', function(req,res) {

    console.log('Infobip:: Webhook RECEIVED Message from Infobip API')
    console.log(JSON.stringify(req.body))
    var incoming = req.body.results[0]
    var text = incoming.message.text
    var msgId = incoming.messageId
    var phoneNumber = incoming.from
    console.log("Incoming Text:"+text+" with MessageID: "+incoming.messageId+" from phoneNumber: "+phoneNumber)
    var en = 'en'
    var session_id = '123456'

    res.send(JSON.stringify({result: "Message received"}))

    startProcessing(text, phoneNumber, msgId, "WHATSAPP");
  });
  

  async function startProcessing(text, userId, msgId, res) {

      let client 

      //Log Incoming message in DB
      try {
        client = await MongoClient.connect(mongo_url)
        db = client.db('payments')  
        
        msgId = msgId+generateRandomNumber()
        var message = { messageId: msgId, channel: "WHATSAPP", mobileNumber: userId, cifid: "", incomingMessage: text, outgoingMessage: "", intent: "", receivedAt: new Date(), respondedAt: "", status: "In Progress"}

        await db.collection('MessagingHistory').insertOne(message)
        console.log("**** DB INSERT Successful -- For incoming message :"+message.messageId +"\n")
      }
      catch(err) {
        console.log("Error in inserting the incoming message in Mongo"+err.stack)
      }
      
      //Parse raw text from customer using LUIS
      var endpoint = "https://westus.api.cognitive.microsoft.com/luis/v2.0/apps/";
      var luisAppId = "a65d337c-b9ac-44b7-a5af-bd64032dcd20";
      var queryParams = {
            "subscription-key": "7115f53052624e7a995d385272b58bc1",
            "timezoneOffset": "240",
            "verbose":  true,
            "q": text
        }
      var luisURL =
            endpoint + luisAppId +
            '?' + querystring.stringify(queryParams);

      axios.get(luisURL)
              .then(response => {
                console.log('Response from LUIS:'+JSON.stringify(response.data)+"\n");
                let luisResponse = response.data;
                processCustomerIntent(luisResponse,userId, msgId, res)
              })
              .catch(err => {
                res.end('Error :' + err)
              })
  }

  async function processCustomerIntent(luisResponse,userId, msgId, res) {
    let intent = luisResponse.topScoringIntent.intent;
    let entityList = luisResponse.entities;
    var intentProfile = null;
    let entitiesFromLUIS = collectEntityNames(entityList)
    var responseMessage = ""
    var conversation = ""
    var missingEntities = []
    var entityToFill = ""
    var filledEntities = []
    var entitiesFilled = false
    var nextExpectedIntent = ""
    var entityQueried
    
    updateMessageLog(msgId, "intent", intent)
    
    try {
      var ongoingConversation = await db.collection('Conversations').findOne({'mobileNumber': userId, 'isConversationOpen': true})
      console.log("%%%%% Ongoing Conversation %%%%%% ::"+JSON.stringify(ongoingConversation))

      var intentProfile = await db.collection('Intents').findOne({'intentId': intent})
    }
    catch(err) {
      console.log("Error finding the Ongoing conversation::"+err.stack)
    }
    
    if(ongoingConversation !== null && ongoingConversation.status === "In Progress") {
      entityToFill = ongoingConversation.entityQueried.name
      expectedIntent = ongoingConversation.entityQueried.expectedIntent

      if(intent === expectedIntent) {
        if(intent !== "Confirmation") {
          ongoingConversation = fillMissingEntities(ongoingConversation, entityList)
          
          try {
            var conversationUpdate = await db.collection('Conversations').updateOne({"conversationId" : ongoingConversation.conversationId},  
                                          {
                                            $set: {"isConversationOpen": ongoingConversation.isConversationOpen, "status": ongoingConversation.status, "entities": ongoingConversation.entities, "missingEntities": ongoingConversation.missingEntities, "entitiesFilled": ongoingConversation.entitiesFilled, "entityQueried.name": ongoingConversation.entityQueried.name, "entityQueried.expectedIntent": ongoingConversation.entityQueried.expectedIntent}
                                          })
            console.log("%%% CONVERSATION updated Successful with MISSING ENTITIES updated ")
            responseMessage = constructResponseMessage(ongoingConversation)
            postMessage(responseMessage, userId, msgId, res)
          }
          catch(err) {
            console.log("Error updating the state of Ongoing conversation::"+err.stack)
          }
        }
        else {
          try {
            ongoingConversation.isConversationOpen = false
            ongoingConversation.isConfirmationRequired = false
            ongoingConversation.status = "Completed"
            ongoingConversation.entityQueried.name = ""
            ongoingConversation.entityQueried.expectedIntent = ""

            var conversationUpdate = await db.collection('Conversations').updateOne({"conversationId" : ongoingConversation.conversationId},  
                                          {
                                            $set: {"isConversationOpen": ongoingConversation.isConversationOpen, "isConfirmationRequired": ongoingConversation.isConfirmationRequired, "status": ongoingConversation.status, "entityQueried.name": ongoingConversation.entityQueried.name, "entityQueried.expectedIntent": ongoingConversation.entityQueried.expectedIntent}
                                          })
            console.log("%%% CONVERSATION updated Successful with CONFIRMATION")
            responseMessage = constructResponseMessage(ongoingConversation)
            postMessage(responseMessage, userId, msgId, res)
          }
          catch(err) {
            console.log("Error updating the state of Ongoing conversation::"+err.stack)
          } 
        }
      }
    }
    else {
            if(intentProfile.isConversational) {
              mandatoryEntities = intentProfile.entities.mandatory;
              console.log('mandatory Items: ====> '+mandatoryEntities)

              entityQueried = {"name" : "", "expectedIntent": ""}

              conversation = {conversationId: msgId+generateRandomNumber(), mobileNumber: userId, cifId: "", isConversationOpen: true, isConfirmationRequired: intentProfile.isConfirmationRequired, context: intent, conversationIntent: intent, missingEntities: [], expectedEntities: mandatoryEntities, entities: [], status: "In Progress", entitiesFilled: false, conversationStartedAt: new Date(), responseMessage: intentProfile.responseMessage, entityQueried: entityQueried}

              conversation = fillMissingEntities(conversation, entityList)

              /*missingEntities = findMissingEntities(mandatoryEntities, entitiesFromLUIS)  
              console.log("&&**&&*& Missing entities "+missingEntities)

              entitiesFilled = (missingEntities.length === 0) ? true : false
              entityToFill = entitiesFilled ? "Confirmation" : missingEntities[0]
              nextExpectedIntent = entitiesFilled ? "Confirmation" : missingEntities[0]+"Slot"

              entityQueried = {"name" : entityToFill, "expectedIntent": nextExpectedIntent}


             conversation = {conversationId: msgId+generateRandomNumber(), mobileNumber: userId, cifId: "", isConversationOpen: true, isConfirmationRequired: intentProfile.isConfirmationRequired, context: intent, conversationIntent: intent, missingEntities: missingEntities, expectedEntities: mandatoryEntities, entities: entityList, status: "In Progress", entitiesFilled: entitiesFilled, conversationStartedAt: new Date(), responseMessage: intentProfile.responseMessage, entityQueried: entityQueried}*/
              logNewConversation(conversation)

              responseMessage = constructResponseMessage(conversation)
              postMessage(responseMessage, userId, msgId, res)
            }
            else {
              responseMessage = intentProfile.responseMessage.finalMessage
              postMessage(responseMessage, userId, msgId, res)  
            }
    }
    
  }

  function generateRandomNumber() {
    let randomNumber = randomString({length: 6, numeric: true, letters: true})
    console.log("Random Number: "+randomNumber)
    return randomNumber
  }

  function updateMessageLog(msgId, attributeToUpdate, attributeValue) {
    
    var objectToUpdate = {}
    objectToUpdate[attributeToUpdate] = attributeValue
    db.collection('MessagingHistory').updateOne({"messageId" : msgId},
                  {
                    $set: objectToUpdate
                  }, function(err, results) {
                    if(err) {
                      console.log("**********Error in updating the MessagesHistory******* :: "+err)
                    }
                    else {
                      console.log('*&*&**** SUCCESS!! Updated the DB &**** '+results);    
                    }
                  })
  }

  function logNewConversation(conversation) {
    console.log("**** Gonna start the conversation in DB ***")
    console.log("%%%%%Conversation to be store: \n"+JSON.stringify(conversation))
    db.collection('Conversations').insertOne(conversation, function(err, docs){
        if(err)
        {
          console.log("Error in inserting the incoming message in Mongo")
        }
        else
        {
          console.log("**** DB INSERT Successful -- For incoming message :"+conversation.mobileNumber +"\n")
        }
      })
  }

  function updateConversationState(conversationId, attributeToUpdate, attributeValue) {
    
    var objectToUpdate = {}
    objectToUpdate[attributeToUpdate] = attributeValue
    db.collection('Conversations').updateOne({"conversationId" : conversationId},
                  {
                    $set: objectToUpdate
                  }, function(err, results) {
                    if(err) {
                      console.log("**********Error in updating the MessagesHistory******* :: "+err)
                    }
                    else {
                      console.log('*&*&**** SUCCESS!! Updated the DB &**** '+results);    
                    }
                  })
  }

  function fillMissingEntities(conversation, entityList) {
    var filledEntities = conversation.entities
    for (var i=0; i<entityList.length; i++) {
        filledEntities.push(entityList[i])
    }
    
    conversation.entities = filledEntities

    conversation.missingEntities = findMissingEntities(conversation.expectedEntities, collectEntityNames(filledEntities))

    conversation.entitiesFilled = (conversation.missingEntities.length === 0) ? true : false
    conversation.entityQueried.name = conversation.entitiesFilled ? (conversation.isConfirmationRequired ? "Confirmation" : "") : conversation.missingEntities[0]
    conversation.entityQueried.expectedIntent = conversation.entitiesFilled ? (conversation.isConfirmationRequired ? "Confirmation" : "") : conversation.missingEntities[0]+"Slot"

    if(conversation.entitiesFilled && !conversation.isConfirmationRequired) {
      conversation.isConversationOpen = false
      conversation.status = "Completed"
    }
    return conversation
  }

  function collectEntityNames(entityList) {
    var entityNames = []
    entityList.forEach(entityItem => {
      entityNames.push(entityItem.type)
    })
    return entityNames;
  }

  function findMissingEntities(mandatoryEntities, filledEntities) {
    var missingEntities = []
    mandatoryEntities.sort();
    filledEntities.sort();
    console.log("&&&&& == "+JSON.stringify(mandatoryEntities))
    console.log("&&&&& == "+JSON.stringify(filledEntities))
    for (var i=0; i<mandatoryEntities.length; i++) {
      if(filledEntities.indexOf(mandatoryEntities[i]) <= -1) {
        missingEntities.push(mandatoryEntities[i])
      }
    }
    return missingEntities
  }

  function constructResponseMessage(conversation) {

    var missingEntities = conversation.missingEntities
    var entities = conversation.entities
    var responseText = null
    console.log("CONSTRUCTING the messages: ")
    console.log("Missing Entities. " +missingEntities)
    console.log("Entity FILLED %% True or FALSE%% :" + conversation.entitiesFilled)
    console.log("Confirmation NEEDED%% True or FALSE%% :" + conversation.isConfirmationRequired)

    if(conversation.entitiesFilled) {
      if(conversation.isConfirmationRequired) {
        console.log('CONFIRMATION required')
        responseText = conversation.responseMessage.confirmMessage
      }
      else {
        console.log('%% NO %% CONFIRMATION required')
        responseText = conversation.responseMessage.finalMessage
      }
    }
    else if(!conversation.entitiesFilled) {
      missingEntity = missingEntities[0]
      let missingEntityMessagesMap = new Map(conversation.responseMessage.missingEntityMessage)
      responseText = missingEntityMessagesMap.get(missingEntity)
      console.log("Response mesages for MISSING entity " + responseText)
    }

    if(entities.length !== 0) {
          entities.forEach(entityItem => {
          let replaceText = '#'+entityItem.type
          responseText = responseText.replace(replaceText, entityItem.entity)
        })  
      } 

    console.log("**FINAL RESPONSE text constructed :: "+responseText)
    return responseText;
  }

  var port = process.env.PORT || 7007;

  app.listen(port, function() {
    console.log('Telegram app listening on port '+port);
  });

  function postMessage(message, userId, msgId, res) {

    if(res === 'WHATSAPP') {
      postWAMessageviaInfoBip(message, userId, msgId)
    }
    else {
      axios.post(botURL, {
          chat_id: userId,
          text: message
        })
          .then(response => {
            console.log('Message posted')
            res.end('ok')
          })  
          .catch(err => {
            console.log('Error :', err)
            res.end('Error :' + err)
          })
    }
    
  }
  
  function postWAMessageviaInfoBip(message, phone_number, msgId) {
      var infoBipURL = "https://api.infobip.com/omni/1/advanced";
      var omniScenarioKey = "2331DDD18BA864FCFF0FD6894F1E8C54";

     let data = JSON.stringify({
                        scenarioKey: omniScenarioKey,
                        destinations: [
                          {
                            to:{
                              phoneNumber: phone_number
                            }
                          }
                        ],
                        whatsApp: {
                          text: message
                        }
                })

      console.log("Sending below Request to InfoBip: "+data)

      axios.post(infoBipURL, data, {
        //headers: { "Authorization":"9b485aa8-a5d5-45c3-bd57-2ad875baae2d", "Content-Type":"application/json"}
        headers: { "Authorization":"App 45d7bc54633f79e3d2211e96b8894bb8-eddb5e89-1a81-4ed0-9562-d4b6e70dfa9a", "Content-Type":"application/json"}
        })
        .then(response => {
          console.log('WA Message posted')
          updateMessageLog(msgId, "outgoingMessage", message)
          updateMessageLog(msgId, "respondedAt", new Date())
          updateMessageLog(msgId, "status", "Completed")
        })  
        .catch(err => {
          console.log('Error :', err)
          //updateMessageLog(msgId, "outgoingMessage", message)
          updateMessageLog(msgId, "status", "Failed")
        })
    }


























  app.get('/getDocumentsList',function(req,res){ 
    console.log("SANTY BOT: API Call to getDocumentsList")

    var url_parts = url.parse(req.url, true);
    var query = url_parts.query;

    var cifid = query.cifid;
    console.log('Mobile number from Request:'+cifid);

    var data = 'Completed';
    console.log("About to response 200 OK");

    res.send(data);
  });

  app.get('/getAllDocumentsList',function(req,res){ 
    console.log("SANTY BOT: API Call to getDocumentsList")

    db.collection('kyclist').find().toArray(function(err, docs){
      if(err)
      {
        res.status(400).send('Error');
      }
      else
      {
        console.log('Mongo DB call response:'+JSON.stringify(docs))
        res.send(docs);
      }
    })
    console.log("Responded 200 OK");
  });

  app.post('/dr-message', function(req, res) {
    const {message} = req.body;

    console.log('Call from SanRemit Bot::'+JSON.stringify(message))
    var respsonseText;

    if(typeof message.text !== "undefined") {
      const text = message.text;
      startProcessing(text, message.chat.id, "", res);
    }

    return res.end('ok')
  })





  app.post('/new-message', function(req, res) {
    const {message} = req.body

    console.log("SANTY BOT -- JSON Stringified Request::"+JSON.stringify(message));
    
    if (!message) {
      console.log("SANTY BOT - NO MESSAGE");
      return res.end()
    }

    console.log("SANTY BOT - MESSAGE RECEIVED");

    if(typeof message.text!=="undefined") {     
      
      console.log("SANTY BOT - Message in LOWER CASE:"+message.text.toLowerCase());
      var mtext = message.text;

      if (mtext.toLowerCase().indexOf('hello') !== -1 || mtext.toLowerCase().indexOf('/start') !== -1 || mtext.toLowerCase().indexOf('hi') !== -1) {
        var dltoken = null;
        var customerName = "";
        if(mtext.toLowerCase().indexOf('/start') !== -1 ) {
            let splitText = mtext.split(" ",2)
            dltoken = splitText[1]
            console.log('DL Token from chat user:'+dltoken)

            if(dltoken !== 'undefined') {
              if(db === null) {
                MongoClient.connect(mongo_url, function (err, database) {
                  console.log('Database connected:'+database)
                  db = database.db('payments')
                  db.collection('kyclist').updateOne({"dltoken" : dltoken},
                  {
                    $set: { "chatid": message.chat.id},
                  }, function(err, results) {
                    console.log(results);
                  })
                });
              }  
            }              
        }

        MongoClient.connect(mongo_url, function (err, database) {
          console.log('Database connected:'+database)
          db = database.db('payments')
          db.collection('kyclist').findOne({'chatid':message.chat.id}, function(err, docs){
          if(err)
          {
            console.log("Error in checking DL Token in Mongo")
          }
          else
          {
            //console.log("Response from Mongo for DL token:"+docs)
            customerName = docs.name;
            console.log('Customer Name:'+customerName)
            axios.post('https://api.telegram.org/bot576925049:AAHrzLIRFFZFd-tU8IPxElcaTjazCGcVy8c/sendMessage', {
                chat_id: message.chat.id,
                text: 'Dear '+customerName+', I can help you with completing the KYC process by uploading the pending documents to the bank from here. To start with, please verify your mobile number by tapping on below button!',
                reply_markup: JSON.stringify({keyboard: [[{ text: "Click to verify your mobile number", request_contact: true, }]], one_time_keyboard: true})
            })
              .then(response => {
                console.log('Message posted')
                res.end('ok')
              })  
              .catch(err => {
                console.log('Error :', err)
                res.end('Error :' + err)
              })
            }
          })
        });

           
      }
      else {
        console.log("SANTY BOT:"+message.text);
        var stext;
        if (mtext.toLowerCase().indexOf('passport') !== -1 || mtext.toLowerCase().indexOf('emiratesid') !== -1 || mtext.toLowerCase().indexOf('visa') !== -1 || mtext.toLowerCase().indexOf('fatca') !== -1) {
          stext = "Please proceed with uploading front and back copy of your "+mtext; 
        }
        else {
          stext = "Sorry I did not understand your query or selection. I can help you with uploading documents to ENBD. But if there is anything else, please check with this guy @ENBDFatherBot";
        }
        //Extract as a function
        axios.post('https://api.telegram.org/bot576925049:AAHrzLIRFFZFd-tU8IPxElcaTjazCGcVy8c/sendMessage', {
          chat_id: message.chat.id,
          text: stext
        })
          .then(response => {
            console.log('Message posted')
            res.end('ok')
          })  
          .catch(err => {
            console.log('Error :', err)
            res.end('Error :' + err)
          })
      }
    }
    else if(typeof message.contact!=="undefined") {
      console.log("SANTY BOT - ***CONTACT received****");
      let mobilenumber = message.contact.phone_number;
      var registeredMobile;
      console.log("SANTY BOT - Mobile number:"+mobilenumber);

      db.collection('kyclist').findOne({'chatid':message.chat.id}, function(err, docs){
        if(err)
        {
          console.log("Error in checking DL Token in Mongo")
        }
        else
        {
          registeredMobile = docs.mobile;
          console.log('Customer Name:'+registeredMobile);
          if(registeredMobile === mobilenumber) {
              axios.post('https://api.telegram.org/bot576925049:AAHrzLIRFFZFd-tU8IPxElcaTjazCGcVy8c/sendMessage', {
                  chat_id: message.chat.id,
                  text: 'Good, looks like you have not yet submitted the below documents. Please select which one would you like to start with',
                  reply_markup: JSON.stringify({keyboard: [[{text: "Passport"},{text: "EmiratesID"}],[{text: "VISA"},{text: "FATCA"}]], one_time_keyboard: true})
              })
              .then(response => {
                  console.log('Message posted')
                  res.end('ok')
              })  
              .catch(err => {
                  console.log('Error :', err)
                  res.end('Error :' + err)
              })
          }
          else {
              axios.post('https://api.telegram.org/bot576925049:AAHrzLIRFFZFd-tU8IPxElcaTjazCGcVy8c/sendMessage', {
                  chat_id: message.chat.id,
                  text: 'Looks like this is not your registered mobile number with us. So we are sorry that you will not able to proceed further from here'
              })
              .then(response => {
                  console.log('Message posted')
                  res.end('ok')
              })  
              .catch(err => {
                  console.log('Error :', err)
                  res.end('Error :' + err)
              })
          }
        }
      });     
    }

    console.log("SANTY BOT: Checking if any doc uploaded....");

    if (typeof message.document!=="undefined" || typeof message.photo!=="undefined") {
      console.log("SANTY BOT - ***Photo or document received****");
      var fileId;
      if(typeof message.document!=="undefined") {
          console.log("SANTY BOT - Document's Metadata Received:"+JSON.stringify(message.document));
          fileId = message.document.file_id;
      }
      else {
          console.log("SANTY BOT - Photo's Metadata Received:"+JSON.stringify(message.photo));
          fileId = message.photo[2].file_id;
      }
      console.log("SANTY BOT - File ID of uploaded File:"+fileId);

      let url = 'https://api.telegram.org/bot576925049:AAHrzLIRFFZFd-tU8IPxElcaTjazCGcVy8c/getFile?file_id='+fileId;
      console.log("SANTY BOT - URL to getFile's Path:"+url);
      let isSelfie = false;

      //Extract as a function
      db.collection('kyclist').findOne({'chatid':message.chat.id}, function(err, docs){
          if(err)
          {
            console.log("Error in checking DL Token in Mongo")
          }
          else
          {
            status = docs.status
            selfieInitiated = docs.selfieInitiated
            if(selfieInitiated === "YES") {
              isSelfie = true;
            }
            else {
              isSelfie = false;
            }
          }
      })

      axios.get(url)
        .then(response => {
          console.log('Get REquest to GetFilePath SUCCESS!!');
          console.log('Response from GEtFile:'+JSON.stringify(response.data));
          console.log('Type of Response.data::'+typeof response.data);
          let filePath = '';
          if(typeof response.data.result !=="undefined") {
            filePath = response.data.result.file_path;
          }
          else if (typeof response.data.file_path !=="undefined") {
            filePath = response.data.file_path;
          }
          else {
            filePath = 'documents/file_7.JPG';
          }
          
          let fileURL = 'https://api.telegram.org/file/bot576925049:AAHrzLIRFFZFd-tU8IPxElcaTjazCGcVy8c/'+filePath;

          detectFace(fileURL,message.chat.id,isSelfie);

          let kycStatus = isSelfie ? "COMPLETED" : "UPLOADED"
          console.log("---------------KYC Status::"+kycStatus)

          if(!isSelfie) {
            db.collection('kyclist').updateOne({"chatid" : message.chat.id},
            {
              $set: { "fileurl": fileURL},
            }, function(err, results) {
                if(err) {
                console.log('UPDATEERROR!!!!! to Mongo DB'+err)
              }
              else {
               console.log("FILE URL Updated successfuly")
              }
            });  
          }

          db.collection('kyclist').updateOne({"chatid" : message.chat.id},
          {
            $set: { "status": kycStatus},
          }, function(err, results) {
             if(err) {
              console.log('UPDATEERROR!!!!! to Mongo DB'+err)
            }
            else {
              db.collection('kyclist').findOne({'chatid':message.chat.id}, function(err, docs){
                if(err)
                {
                    console.log("Error in checking DL Token in Mongo")
                }
                else
                {
                  let finStatus = docs.status
                  console.log("---------------DOCS Status::"+status)
                  if(finStatus === "UPLOADED") {
                    postMessage("Almost there! let's take a selfie to verify who is uploading",message.chat.id,res,kycbotURL)
                    updateSelfieStatus("YES",message.chat.id)
                  }
                  else if(finStatus === "COMPLETED") {
                    //postMessage("Cool, let us upload the next document",message.chat.id,res) 
                    db.collection('kyclist').findOne({'chatid':message.chat.id}, function(err, docs){
                    if(err)
                    {
                      console.log("Error in checking DL Token in Mongo")
                    }
                    else
                    {
                      if(docs.selfieFaceId !== "") {
                        verifyFaceAndCompleteKYC(message.chat.id,res)
                      }
                      else
                      {
                        sleep(500).then(() => {
                          verifyFaceAndCompleteKYC(message.chat.id,res)
                        });
                     } 
                    }
                  })
                    
                  }
                  else {
                    postMessage("Cool, let us upload the next document",message.chat.id,res,kycbotURL) 
                  }
                }
              })
            }
          });
          
          axios.get(fileURL, {responseType: 'stream'})
            .then(response => {
              console.log('File Downloaded from obtianed file path');
              let fileName = 'Passport_TG_'+message.chat.id+'.jpeg';
              console.log('File name constructed:'+fileName);
              // console.log('***FILE CONTENT****::'+response.data);
              response.data.pipe(fs.createWriteStream(fileName));
              console.log('File Downloaded successfuly @:'+fileName);
            })
            .catch(err => {
              console.log('Error :', err)
              res.end('Error :' + err)
            })
          res.end('ok')
        })
        .catch(err => {
            console.log('Error :', err)
            res.end('Error :' + err)
        })
    }

    });

  function detectFace(sourceImageUrl,chatid, isSelfie) {
          
          var subscriptionKey = "e442cdfd339f46c895e3f72fce46c5c8";
          var uriBase = "https://northeurope.api.cognitive.microsoft.com/face/v1.0/detect";

          var params = {
              "returnFaceId": "true",
              "returnFaceLandmarks": "false",
              "returnFaceAttributes": "age,gender,headPose,smile,facialHair,glasses,emotion,hair,makeup,occlusion,accessories,blur,exposure,noise",
          };

          let data = JSON.stringify({
                        url: sourceImageUrl
                      })

          axios.post(uriBase, data, {
            headers: { "Content-Type":"application/json", "Ocp-Apim-Subscription-Key":"1e4d1fb44fc24ba392aef5fa4e5fcd9d" }
          })
          .then(response => {
            console.log('Response from Face API'+JSON.stringify(response.data));
            let faceid = response.data[0].faceId;
            console.log("SANTY BOT: FAce ID from Document:"+faceid);
            if(isSelfie) {
              updateSelfieFaceId(faceid,chatid)
            }   
            else {
              updateDocFaceId(faceid,chatid)
            }
          })  
          .catch(err => {
            console.log('Error :', err)
          })
      };

    function verifyFaceAndCompleteKYC(chatid, res) {

      var subscriptionKey = "e442cdfd339f46c895e3f72fce46c5c8";
      var uriBase = "https://northeurope.api.cognitive.microsoft.com/face/v1.0/verify";

      db.collection('kyclist').findOne({'chatid':chatid}, function(err, docs){
          if(err)
          {
            console.log("Error in checking DL Token in Mongo")
          }
          else
          {
            let docFaceId = docs.docFaceId;
            let selfieFaceId = docs.selfieFaceId;
            let isIdentical;
            let confidence;

            let data = JSON.stringify({
                        faceId1: docFaceId,
                        faceId2: selfieFaceId
                      })

            axios.post(uriBase, data, {
              headers: { "Content-Type":"application/json", "Ocp-Apim-Subscription-Key":"1e4d1fb44fc24ba392aef5fa4e5fcd9d" }
            })
            .then(response => {
              console.log('Response from Verify FACE API'+JSON.stringify(response.data));
              isIdentical = response.data.isIdentical
              confidence = response.data.confidence
              console.log("SANTY BOT: isIdentical "+isIdentical+" confidence "+confidence);
              let message = isIdentical ? "Great, we have successfuly completed the process and we will get back to you if required. Thank you for your cooperation" : "We could not verify your face on the ID, looks like it is someone else uploading the docs"
              postMessage(message,chatid,res,kycbotURL);
            })  
            .catch(err => {
              console.log('Error :', err)
            })
          }
        });
    }

    function updateDocFaceId(faceid, chatid) {
      db.collection('kyclist').updateOne({"chatid" : chatid},
            {
              $set: {"docFaceId": faceid},
            }, function(err, results) {
              if(err) {
                console.log('UPDATEERROR!!!!! to Mongo DB'+err)
              }
              else {
                console.log(results);
              }
            });
    }

    function updateSelfieStatus(selfieInitiated, chatid) {
      db.collection('kyclist').updateOne({"chatid" : chatid},
            {
              $set: {"selfieInitiated": "YES"},
            }, function(err, results) {
              if(err) {
                console.log('UPDATEERROR!!!!! to Mongo DB'+err)
              }
              else {
                console.log(results);
              }
            });
    }

    function updateSelfieFaceId(faceid, chatid) {
      db.collection('kyclist').updateOne({"chatid" : chatid},
            {
              $set: {"selfieFaceId": faceid},
            }, function(err, results) {
              if(err) {
                console.log('UPDATEERROR!!!!! to Mongo DB'+err)
              }
              else {
                console.log(results);
              }
            });
    }

    function postC2BMessage(clientId, message, wtransport,res) {
      var c2bURL = "https://api.chat2brand.co.za/v1/messages";

      let data = JSON.stringify({
                        client_id: clientId,
                        text: message,
                        transport: wtransport
                      })

      axios.post(c2bURL, data, {
        headers: { "Content-Type":"application/json;charset=UTF-8", "Authorization":"feb4182dcdb61c41f4c2db59ad2d6c", "Accept-Encoding":"application/json" }
        })
        .then(response => {
          console.log('WA Message posted')
          res.end('ok')
        })  
        .catch(err => {
          console.log('Error :', err)
        })
    }

    // sleep time expects milliseconds
  function sleep (time) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }




    