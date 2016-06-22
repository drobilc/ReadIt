var http = require('http');
var express = require('express');
var jade = require('jade');
var bodyParser = require('body-parser');
var request = require("request");
var Snoocore = require('snoocore');
var epubGenerator = require('epub-generator');
var fs = require('fs');
var doT = require('dot');
var phantom = require('phantom');
var pdf = require('html-pdf');
var child_process = require('child_process');

function generateBook(prompt, comments, filename, callback){

  var title = prompt.title;
  var author = prompt.author;
  var selftext = prompt.selftext;

  var css = '* { margin: 0; padding: 0; } .prompt { border: 1px solid black; height: 200px; } .prompt .title { font-size: 20px; font-weight: bold; }  p { font-size: 1.1em; line-height: 1.6em; font-family: "Georgia",serif; margin-bottom: 0.6em; margin-right: 0.6em; } .authorp { font-style: italic; font-weight: bold; font-size: 1.1em; float: right;}';
  var html = '<div class="prompt"><span class="title">'+title+'</span><span class="selftext">'+selftext+'</span><span class="author">'+author+'</span></div>';
  var xhtml = '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><link href="style.css" rel="stylesheet" type="text/css"/><head><title>'+title+'</title></head><body>'+html+'</body></html>';

  var response = doT.template('<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><link href="style.css" rel="stylesheet" type="text/css"/><head></head><body>{{=it.data}}</body></html>');
  var tempFn = doT.template('<div class=""><div class="body">{{=it.body}}</div><div class="author"><p class="authorp">{{=it.author}}</p></div></div>');

  var epubStream = epubGenerator({
  		title: title,
  		author: author
  	})
  	.add('index.xhtml', xhtml, {
  		title: "Prompt",
  		toc: true
  	}).add('style.css', css, {
      mimetype: 'text/css',
      title: 'style.css',
  		toc: false
  	});

    for (var i = 0; i < comments.length; i++){
      var resultText = tempFn(comments[i]);
      epubStream.add(comments[i].id + '.xhtml', response({data: resultText}), {
        title: 'Response by: ' + comments[i].author,
        toc: true
      });
    }

    epubStream.end()
  	.pipe( fs.createWriteStream('books/' + filename + '.epub') ).on('finish', callback);;

  epubStream.on('error', function(err){
  	console.trace(err);
  });

}

function generatePDF(prompt, comments, filename){
  var title = prompt.title;
  var author = prompt.author;
  var selftext = prompt.selftext;

  var css = '* { margin: 0; padding: 0; } body { padding: 100px; } .around:not(:first-child) { page-break-before: always; } p { font-size: 1.4em; font-family: "Georgia",serif; margin-bottom: 1.2em; } .authorp { font-style: italic; font-weight: bold; font-size: 1.3em; float: right;}';
  var response = doT.template('<html><head><style>'+css+'</style></head><body>{{=it.data}}</body></html>');
  var tempFn = doT.template('<div class="around"><div class="body">{{=it.body}}</div><div class="author"><p class="authorp">{{=it.author}}</p></div></div>');

  var toWrite = "";
    for (var i = 0; i < comments.length; i++){
      var resultText = tempFn(comments[i]);
      toWrite += resultText;
    }

    var html = response({data: toWrite});

  var options = { format: 'A4' };
  pdf.create(html, options).toFile('books/'+filename+'.pdf', function(err, res) {
    if (err) return console.log(err);
    console.log(res);
  });
}

function convertToMobi(filename){
  child_process.exec('converter\\kindlegen.exe books\\' + filename + '.epub', function (err, stdout, stderr){
    if (!err)
      console.log("Converted " + filename + ".epub to " + filename + ".mobi");
  });
}

var reddit = new Snoocore({
  userAgent: 'ReaddIt book maker',
  oauth: {
    type: 'script',
    key: 'Dfbnknw1mATyGQ',
    secret: 'lWrmeq_SRYBSDnpFVl8vywGbtUM',
    username: 'drobilc',
    password: 'n1k1b1zj4k',
    scope: [ 'flair', 'identity', 'read' ]
  }
});

var port = 3000;
var app = express();

app.engine('jade', require('jade').__express);
app.set('view engine', 'jade');
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/slike/', express.static(__dirname + '/views/slike/'));
app.use('/download/', express.static(__dirname + '/books/'));

var podatki;
var interval;

function parseComments(podatki){
  var allComments = [];
  for (var i = 0; i < podatki.length; i++){
    var comment = podatki[i].data;
    var commentAuthor = comment.author;
    var commentBody = comment.body;
    var commentId = comment.id;
    if (commentAuthor || commentBody)
      allComments.push({id: comment.id, author: commentAuthor, body: commentBody});
  }
  return allComments;
}

function unescapeHTML(html) {
  if (html){
    var string = html;
    string = string.replace(/&apos;/g, "\'");
    string = string.replace(/&quot;/g, "\"");
    string = string.replace(/&amp;/g, "\&");
    string = string.replace(/&lt;/g, "<");
    string = string.replace(/&gt;/g, ">");
    return string;
  }
}

function updateData(){
  reddit('/r/writingprompts/top').listing().then(function(data){
    podatki = data.children;
  });
}

function fileExists(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch (err) {
        return false;
    }
}

app.get('/', function(req, res, next) {
  if (podatki)
    res.render("index", {podatki: podatki});
  else
    res.send("ERROR");
});

app.get('/post/:id', function(req, res, next) {

  var postId = req.params.id;
  console.log("User requested: " + postId);

  //If file already exists, we redirect user to download/postId.epub
  if (fileExists('books/' + postId + '.epub')) {
    res.redirect('../book/' + postId);
  }
  //Else redirect user to download/postId.epub download first comment and create book
  else {
    res.redirect('../book/' + postId);

    //Do all the other stuff in background
    reddit('comments/' + postId).listing({limit: 100, depth: 1}, {listingIndex: 1}).then(function(slice) {

      //Get post information
      var postData = slice.get[0].data.children[0].data;
      var title = postData.title;
      var selftext = postData.selftext;
      var author = postData.author;
      var url = postData.url;
      var upvotes = postData.ups;
      var numberOfComments = postData.num_comments;

      //Extract prompt title and remove [wp],[eu],... from title
      var promptTypes = ["wp:Writing Prompt", "eu:Established Universe", "cw:Constrained Writing", "tt:Theme Thursday", "mp:Media Prompt", "ip:Image Prompt", "rf:Reality Fiction", "pm:Prompt Me", "pi:Prompt Inspired", "cc:Constructive Criticism", "ot:Off Topic"];

      var pattern = /\s?[\[\(\{](.{2})[\]\)\}]\s?/gi;
      title = (pattern.test(title)) ? title.replace(pattern, "") : title;

      var allComments = parseComments(slice.children);

      //Ustvarimo knjigo in jo pretvorimo v pdf ter mobi format
      generateBook({title: title, author: author, selftext: selftext}, allComments, postId, function(){
        convertToMobi(postId);
        generatePDF({title: title, author: author, selftext: selftext}, allComments, postId);
      });

    });
  }

});

app.get('/book/:id', function(req, res, next){
  res.render('book', {id: req.params.id});
});

var server = http.createServer(app);
server.listen(port, function(){
  console.log("Updating data...");
  updateData();
  console.log("Listening on port " + port);
  interval = setInterval(updateData, 2*60*1000);
});
